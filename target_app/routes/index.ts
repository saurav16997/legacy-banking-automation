/** Route placeholders for the future server-rendered synthetic portal. */
export const routesPlaceholder = true;
import { Router, type Request, type Response } from "express";
import type { Store } from "express-session";

import { demoCredentials, FixtureStore, syntheticVerificationCode } from "../fixtures/index.js";

export type TargetScenario = "normal" | "identity_verification_on_review";

interface SavingsDraft {
  memberId: string;
  product: string;
  nickname: string;
  initialDepositCents: number;
  fundingAccountId: string;
  confirmedAccountId?: string;
}

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
    savingsDraft?: SavingsDraft;
    identityVerified?: boolean;
  }
}

export interface PortalRouterOptions {
  fixtures: FixtureStore;
  scenario: TargetScenario;
  enableTestControls: boolean;
  sessionStore: Store;
}

function requireLogin(request: Request, response: Response): boolean {
  if (!request.session.authenticated) {
    response.redirect("/login");
    return false;
  }
  return true;
}

function normalizeMemberId(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function parseDeposit(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    return undefined;
  }
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

export function createPortalRouter(options: PortalRouterOptions): Router {
  const router = Router();
  const { fixtures, scenario, enableTestControls, sessionStore } = options;

  router.get("/", (request, response) => {
    response.redirect(request.session.authenticated ? "/dashboard" : "/login");
  });

  router.get("/login", (request, response) => {
    response.render("login", { error: undefined });
  });

  router.post("/login", (request, response) => {
    const { username, password } = request.body as Record<string, unknown>;
    if (username !== demoCredentials.username || password !== demoCredentials.password) {
      response.status(401).render("login", {
        error: "The username or password was not recognized.",
      });
      return;
    }
    request.session.authenticated = true;
    response.redirect("/dashboard");
  });

  router.post("/logout", (request, response) => {
    request.session.destroy(() => {
      response.redirect("/login");
    });
  });

  router.get("/dashboard", (request, response) => {
    if (!requireLogin(request, response)) return;
    response.render("dashboard");
  });

  router.get("/members/search", (request, response) => {
    if (!requireLogin(request, response)) return;
    response.render("member-search", { error: undefined, query: "" });
  });

  router.post("/members/search", (request, response) => {
    if (!requireLogin(request, response)) return;
    const memberId = normalizeMemberId((request.body as Record<string, unknown>).memberId);
    const member = fixtures.findMember(memberId);
    if (!member) {
      response.status(404).render("member-search", {
        error: `No member was found for ID ${memberId || "(blank)"}.`,
        query: memberId,
      });
      return;
    }
    response.redirect(`/members/${encodeURIComponent(member.id)}`);
  });

  router.get("/members/:memberId", (request, response) => {
    if (!requireLogin(request, response)) return;
    const member = fixtures.findMember(normalizeMemberId(request.params.memberId));
    if (!member) {
      response.status(404).render("not-found");
      return;
    }
    response.render("member-profile", { member });
  });

  router.get("/members/:memberId/savings/new", (request, response) => {
    if (!requireLogin(request, response)) return;
    const member = fixtures.findMember(normalizeMemberId(request.params.memberId));
    if (!member) {
      response.status(404).render("not-found");
      return;
    }
    response.render("savings-new", {
      member,
      errors: [],
      values: { product: "", nickname: "", initialDeposit: "", fundingAccountId: "" },
    });
  });

  router.post("/members/:memberId/savings/new", (request, response) => {
    if (!requireLogin(request, response)) return;
    const member = fixtures.findMember(normalizeMemberId(request.params.memberId));
    if (!member) {
      response.status(404).render("not-found");
      return;
    }

    const body = request.body as Record<string, unknown>;
    const values = {
      product: typeof body.product === "string" ? body.product : "",
      nickname: typeof body.nickname === "string" ? body.nickname.trim() : "",
      initialDeposit: typeof body.initialDeposit === "string" ? body.initialDeposit.trim() : "",
      fundingAccountId: typeof body.fundingAccountId === "string" ? body.fundingAccountId : "",
    };
    const errors: string[] = [];
    const depositCents = parseDeposit(values.initialDeposit);
    const fundingAccount = member.accounts.find(
      (account) => account.id === values.fundingAccountId && account.type === "checking",
    );
    if (values.product !== "Growth Savings") errors.push("Select Growth Savings as the product.");
    if (!values.nickname) errors.push("Enter an account nickname.");
    if (depositCents === undefined || depositCents <= 0) {
      errors.push("Enter an initial deposit greater than $0.00.");
    }
    if (!fundingAccount) errors.push("Select an available checking account for funding.");

    if (errors.length > 0 || depositCents === undefined || !fundingAccount) {
      response.status(422).render("savings-new", { member, errors, values });
      return;
    }

    request.session.savingsDraft = {
      memberId: member.id,
      product: values.product,
      nickname: values.nickname,
      initialDepositCents: depositCents,
      fundingAccountId: fundingAccount.id,
    };
    request.session.identityVerified = scenario === "normal";
    const nextPath =
      scenario === "identity_verification_on_review"
        ? `/members/${member.id}/identity-verification`
        : `/members/${member.id}/savings/review`;
    response.redirect(nextPath);
  });

  router.get("/members/:memberId/identity-verification", (request, response) => {
    if (!requireLogin(request, response)) return;
    const memberId = normalizeMemberId(request.params.memberId);
    if (scenario !== "identity_verification_on_review") {
      response.redirect(`/members/${memberId}/savings/review`);
      return;
    }
    if (request.session.savingsDraft?.memberId !== memberId) {
      response.redirect(`/members/${memberId}/savings/new`);
      return;
    }
    response.render("identity-verification", { memberId, error: undefined });
  });

  router.post("/members/:memberId/identity-verification", (request, response) => {
    if (!requireLogin(request, response)) return;
    const memberId = normalizeMemberId(request.params.memberId);
    const code = (request.body as Record<string, unknown>).verificationCode;
    if (
      scenario !== "identity_verification_on_review" ||
      request.session.savingsDraft?.memberId !== memberId
    ) {
      response.redirect(`/members/${memberId}/savings/new`);
      return;
    }
    if (code !== syntheticVerificationCode) {
      response.status(422).render("identity-verification", {
        memberId,
        error: "The verification code is incorrect.",
      });
      return;
    }
    request.session.identityVerified = true;
    response.redirect(`/members/${memberId}/savings/review`);
  });

  router.get("/members/:memberId/savings/review", (request, response) => {
    if (!requireLogin(request, response)) return;
    const memberId = normalizeMemberId(request.params.memberId);
    const member = fixtures.findMember(memberId);
    const draft = request.session.savingsDraft;
    if (!member || draft?.memberId !== memberId) {
      response.redirect(`/members/${memberId}/savings/new`);
      return;
    }
    if (scenario === "identity_verification_on_review" && !request.session.identityVerified) {
      response.redirect(`/members/${memberId}/identity-verification`);
      return;
    }
    const fundingAccount = member.accounts.find((account) => account.id === draft.fundingAccountId);
    response.render("savings-review", { member, draft, fundingAccount });
  });

  router.post("/members/:memberId/savings/confirm", (request, response) => {
    if (!requireLogin(request, response)) return;
    const memberId = normalizeMemberId(request.params.memberId);
    const draft = request.session.savingsDraft;
    if (draft?.memberId !== memberId) {
      response.status(409).send("No savings application is ready for confirmation.");
      return;
    }
    if (scenario === "identity_verification_on_review" && !request.session.identityVerified) {
      response.redirect(`/members/${memberId}/identity-verification`);
      return;
    }
    if (!draft.confirmedAccountId) {
      const account = fixtures.createSavingsAccount(memberId, draft);
      if (!account) {
        response.status(404).render("not-found");
        return;
      }
      draft.confirmedAccountId = account.id;
    }
    response.redirect(`/members/${memberId}/savings/review`);
  });

  if (enableTestControls) {
    router.post("/__test__/reset", (_request, response) => {
      fixtures.reset();
      if (!sessionStore.clear) {
        response.status(500).json({ ok: false });
        return;
      }
      sessionStore.clear((error) => {
        if (error) {
          response.status(500).json({ ok: false });
          return;
        }
        response.json({ ok: true });
      });
    });
  }

  return router;
}
