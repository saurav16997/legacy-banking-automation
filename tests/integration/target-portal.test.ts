import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTargetApp } from "../../target_app/server.js";

const credentials = { username: "demo.operator", password: "creditunion-demo" };
const application = {
  product: "Growth Savings",
  nickname: "Vacation Fund",
  initialDeposit: "250.00",
  fundingAccountId: "CHK-1842",
};

async function login(agent: ReturnType<typeof request.agent>): Promise<void> {
  await agent
    .post("/login")
    .type("form")
    .send(credentials)
    .expect("Location", "/dashboard")
    .expect(302);
}

async function reachReview(agent: ReturnType<typeof request.agent>): Promise<void> {
  await login(agent);
  await agent
    .post("/members/M-10042/savings/new")
    .type("form")
    .send(application)
    .expect("Location", "/members/M-10042/savings/review")
    .expect(302);
}

describe("synthetic target portal", () => {
  it("logs in and finds the synthetic member", async () => {
    const { app } = createTargetApp();
    const agent = request.agent(app);

    await login(agent);
    const search = await agent
      .post("/members/search")
      .type("form")
      .send({ memberId: "m-10042" })
      .expect("Location", "/members/M-10042")
      .expect(302);
    expect(search.headers.location).toBe("/members/M-10042");
    await agent
      .get("/members/M-10042")
      .expect(200)
      .expect(/Morgan Redwood/);
  });

  it("handles an invalid member search clearly", async () => {
    const { app } = createTargetApp();
    const agent = request.agent(app);
    await login(agent);

    await agent
      .post("/members/search")
      .type("form")
      .send({ memberId: "M-99999" })
      .expect(404)
      .expect(/No member was found for ID M-99999/);
  });

  it("shows validation errors and does not save an invalid draft", async () => {
    const { app } = createTargetApp();
    const agent = request.agent(app);
    await login(agent);

    await agent
      .post("/members/M-10042/savings/new")
      .type("form")
      .send({ product: "", nickname: "", initialDeposit: "-5", fundingAccountId: "" })
      .expect(422)
      .expect(/Select Growth Savings/)
      .expect(/Enter an account nickname/)
      .expect(/initial deposit greater than/);
    await agent
      .get("/members/M-10042/savings/review")
      .expect("Location", "/members/M-10042/savings/new")
      .expect(302);
  });

  it("reaches ready-for-review without creating an account", async () => {
    const target = createTargetApp();
    const agent = request.agent(target.app);
    await reachReview(agent);

    const before = target.fixtures.findMember("M-10042")?.accounts.length;
    await agent
      .get("/members/M-10042/savings/review")
      .expect(200)
      .expect(/data-page-state="ready-for-review"/)
      .expect(/Growth Savings/)
      .expect(/Vacation Fund/)
      .expect(/\$250\.00/)
      .expect(/checking ending 1842/);
    expect(target.fixtures.findMember("M-10042")?.accounts.length).toBe(before);
  });

  it("creates exactly one account and prevents duplicate confirmation", async () => {
    const target = createTargetApp();
    const agent = request.agent(target.app);
    await reachReview(agent);
    const initialCount = target.fixtures.findMember("M-10042")?.accounts.length ?? 0;

    await agent.post("/members/M-10042/savings/confirm").expect(302);
    expect(target.fixtures.findMember("M-10042")?.accounts).toHaveLength(initialCount + 1);
    await agent
      .get("/members/M-10042/savings/review")
      .expect(200)
      .expect(/data-page-state="account-opened"/)
      .expect(/SAV-0001/);

    await agent.post("/members/M-10042/savings/confirm").expect(302);
    expect(target.fixtures.findMember("M-10042")?.accounts).toHaveLength(initialCount + 1);
  });

  it("interrupts for human verification and resumes the same session", async () => {
    const target = createTargetApp({ scenario: "identity_verification_on_review" });
    const agent = request.agent(target.app);
    await login(agent);

    await agent
      .post("/members/M-10042/savings/new")
      .type("form")
      .send(application)
      .expect("Location", "/members/M-10042/identity-verification")
      .expect(302);
    await agent
      .get("/members/M-10042/identity-verification")
      .expect(200)
      .expect(/data-page-state="human-verification-required"/)
      .expect(/Human action required/);
    await agent
      .get("/members/M-10042/savings/review")
      .expect("Location", "/members/M-10042/identity-verification")
      .expect(302);
    expect(target.fixtures.findMember("M-10042")?.accounts).toHaveLength(1);

    const incorrectCode = "000000";
    const rejected = await agent
      .post("/members/M-10042/identity-verification")
      .type("form")
      .send({ verificationCode: incorrectCode })
      .expect(422)
      .expect(/data-page-state="human-verification-required"/)
      .expect(/The verification code is incorrect/);
    expect(rejected.text).not.toContain(incorrectCode);
    await agent
      .get("/members/M-10042/savings/review")
      .expect("Location", "/members/M-10042/identity-verification")
      .expect(302);

    await agent
      .post("/members/M-10042/identity-verification")
      .type("form")
      .send({ verificationCode: "739241" })
      .expect("Location", "/members/M-10042/savings/review")
      .expect(302);
    await agent
      .get("/members/M-10042/savings/review")
      .expect(200)
      .expect(/data-page-state="ready-for-review"/)
      .expect(/Vacation Fund/);
  });

  it("exposes reset controls only when enabled", async () => {
    await request(createTargetApp().app).post("/__test__/reset").expect(404);

    const target = createTargetApp({ enableTestControls: true });
    target.fixtures.createSavingsAccount("M-10042", {
      product: "Growth Savings",
      nickname: "Temporary",
      initialDepositCents: 100,
    });
    await request(target.app).post("/__test__/reset").expect(200, { ok: true });
    expect(target.fixtures.findMember("M-10042")?.accounts).toHaveLength(1);
  });
});
