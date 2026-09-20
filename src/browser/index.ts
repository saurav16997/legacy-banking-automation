import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import {
  type ActionRisk,
  type ControlOwner,
  type ObservedElement,
  type SemanticRole,
  type SemanticTarget,
  type SurfaceActionResult,
  type SurfaceCommand,
  type SurfaceObservation,
} from "../domain/index.js";
import {
  PolicyEngine,
  type PolicyDecision,
  type TrustedControlClassification,
} from "../policy/index.js";

export interface SurfaceAdapter {
  start(): Promise<SurfaceObservation>;
  observe(): Promise<SurfaceObservation>;
  execute(command: SurfaceCommand): Promise<SurfaceActionResult>;
  captureScreenshot(redactions?: readonly string[]): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PlaywrightSurfaceOptions {
  readonly baseUrl: string;
  readonly initialPath?: string;
  readonly headless?: boolean;
  readonly timeoutMs?: number;
  readonly allowSensitiveAutomation?: boolean;
  readonly trustControlMetadata?: boolean;
  readonly trustedControlClassifications?: Readonly<Record<string, TrustedControlClassification>>;
}

interface ElementRegistryEntry {
  readonly observationId: string;
  readonly semanticTarget: SemanticTarget;
  readonly controlOwner: ControlOwner;
  readonly actionRisk: ActionRisk;
  readonly href?: string;
}

interface ElementMetadata {
  readonly owner: ControlOwner;
  readonly risk: ActionRisk;
  readonly sensitive: boolean;
}

const REDACTED_VALUE = "[REDACTED]";
const MAX_VISIBLE_TEXT_LENGTH = 8_000;

/**
 * The only Playwright implementation of the bounded surface contract.
 * Browser objects and selectors are private implementation details.
 */
export class PlaywrightSurface implements SurfaceAdapter {
  readonly #baseUrl: URL;
  readonly #initialUrl: URL;
  readonly #headless: boolean;
  readonly #timeoutMs: number;
  readonly #policy: PolicyEngine;
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #lastObservation: SurfaceObservation | undefined;
  #registry = new Map<string, ElementRegistryEntry>();
  #referenceOrigins = new Map<string, string>();
  #nextElementNumber = 1;

  constructor(options: PlaywrightSurfaceOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#initialUrl = new URL(options.initialPath ?? "/login", this.#baseUrl);
    if (this.#initialUrl.origin !== this.#baseUrl.origin) {
      throw new Error("The initial path must use the configured target-app origin.");
    }
    this.#headless = options.headless ?? false;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#policy = new PolicyEngine({
      allowSensitiveAutomation: options.allowSensitiveAutomation ?? false,
      trustControlMetadata: options.trustControlMetadata ?? false,
      ...(options.trustedControlClassifications
        ? { trustedControlClassifications: options.trustedControlClassifications }
        : {}),
    });
  }

  async start(): Promise<SurfaceObservation> {
    if (this.#page) return this.observe();
    try {
      this.#browser = await chromium.launch({ headless: this.#headless });
      this.#context = await this.#browser.newContext({ acceptDownloads: false });
      this.#page = await this.#context.newPage();
      this.#page.setDefaultTimeout(this.#timeoutMs);
      await this.#page.goto(this.#initialUrl.href, {
        timeout: this.#timeoutMs,
        waitUntil: "domcontentloaded",
      });
      return await this.observe();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async observe(): Promise<SurfaceObservation> {
    const page = this.#requirePage();
    const observationId = randomUUID();
    const labelMap = await this.#readLabels(page);
    const elements: ObservedElement[] = [];
    const nextRegistry = new Map<string, ElementRegistryEntry>();
    const interactive = page.locator("button, a[href], input, select, textarea");
    const count = await interactive.count();

    for (let index = 0; index < count; index += 1) {
      const locator = interactive.nth(index);
      if (!(await locator.isVisible())) continue;
      const observed = await this.#observeElement(locator, labelMap, observationId);
      elements.push(observed.element);
      nextRegistry.set(observed.element.elementRef, observed.entry);
      this.#referenceOrigins.set(observed.element.elementRef, observationId);
    }

    const headingLocator = page.getByRole("heading", { level: 1 }).first();
    const primaryHeading =
      (await headingLocator.count()) > 0 ? (await headingLocator.innerText()).trim() : undefined;
    const pageStateLocator = page.locator("[data-page-state]").first();
    const pageState =
      (await pageStateLocator.count()) > 0
        ? ((await pageStateLocator.getAttribute("data-page-state")) ?? undefined)
        : undefined;
    const visibleText = (await page.locator("body").innerText()).slice(0, MAX_VISIBLE_TEXT_LENGTH);
    const observation: SurfaceObservation = {
      observationId,
      url: page.url(),
      title: await page.title(),
      visibleText,
      elements,
      timestamp: new Date().toISOString(),
      ...(primaryHeading ? { primaryHeading } : {}),
      ...(pageState ? { pageState } : {}),
    };
    this.#registry = nextRegistry;
    this.#lastObservation = observation;
    return observation;
  }

  async execute(command: SurfaceCommand): Promise<SurfaceActionResult> {
    const page = this.#page;
    if (!page) return { status: "FAILED", message: "The browser session is not open." };

    try {
      if (command.operation === "navigate") {
        const targetUrl = new URL(command.url, page.url()).href;
        const decision = this.#policy.evaluateNavigation(targetUrl, this.#baseUrl.origin);
        if (decision.disposition !== "ALLOW") return this.#policyResult(decision);
        await page.goto(targetUrl, { timeout: this.#timeoutMs, waitUntil: "domcontentloaded" });
        return {
          status: "EXECUTED",
          message: "Same-origin navigation completed.",
          observation: await this.observe(),
        };
      }

      if (command.observationId !== this.#lastObservation?.observationId) {
        return { status: "STALE_OBSERVATION", message: "The observation is no longer current." };
      }
      const entry = this.#registry.get(command.elementRef);
      if (entry?.observationId !== command.observationId) {
        const origin = this.#referenceOrigins.get(command.elementRef);
        return {
          status: "STALE_OBSERVATION",
          message: origin
            ? "The element reference belongs to an older observation."
            : "The element reference is not part of the current observation.",
        };
      }

      const decision = this.#policy.evaluateElement({
        controlOwner: entry.controlOwner,
        actionRisk: entry.actionRisk,
      });
      if (decision.disposition !== "ALLOW") return this.#policyResult(decision);
      if (entry.href) {
        const navigationDecision = this.#policy.evaluateNavigation(
          new URL(entry.href, page.url()).href,
          this.#baseUrl.origin,
        );
        if (navigationDecision.disposition !== "ALLOW")
          return this.#policyResult(navigationDecision);
      }

      const locator = this.#resolveSemanticTarget(page, entry.semanticTarget);
      const matchCount = await locator.count();
      if (matchCount !== 1) {
        return {
          status: "AMBIGUOUS_TARGET",
          message: `The semantic target resolved to ${String(matchCount)} elements; exactly one is required.`,
        };
      }

      if (command.operation === "click") {
        await locator.click({ timeout: this.#timeoutMs });
      } else if (command.operation === "fill") {
        await locator.fill(command.value, { timeout: this.#timeoutMs });
      } else {
        await locator.selectOption(command.option, { timeout: this.#timeoutMs });
      }
      return {
        status: "EXECUTED",
        message: `${command.operation} completed.`,
        observation: await this.observe(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.name : "UnknownError";
      return { status: "FAILED", message: `Browser action failed (${message}).` };
    }
  }

  async captureScreenshot(redactions: readonly string[] = []): Promise<Uint8Array> {
    const page = this.#requirePage();
    const evidenceMaskAttribute = "data-interface-cua-evidence-mask";
    const uniqueRedactions = [...new Set(redactions.filter((value) => value.length > 0))];
    await page.locator("body").evaluate(
      (body, options) => {
        const document = body.ownerDocument;
        const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
        const walker = document.createTreeWalker(body, showText);
        let node = walker.nextNode();
        while (node) {
          const parent = node.parentElement;
          if (
            parent &&
            parent !== body &&
            options.redactions.some((redaction) => node?.textContent?.includes(redaction))
          ) {
            parent.setAttribute(options.attribute, "true");
          }
          node = walker.nextNode();
        }
      },
      { attribute: evidenceMaskAttribute, redactions: uniqueRedactions },
    );
    try {
      return await page.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        fullPage: true,
        mask: [
          page.locator("input, select, textarea"),
          page.locator(`[${evidenceMaskAttribute}="true"]`),
        ],
        maskColor: "#000000",
        timeout: this.#timeoutMs,
      });
    } finally {
      await page.locator(`[${evidenceMaskAttribute}="true"]`).evaluateAll((elements, attribute) => {
        for (const element of elements) element.removeAttribute(attribute);
      }, evidenceMaskAttribute);
    }
  }

  async close(): Promise<void> {
    this.#registry.clear();
    this.#lastObservation = undefined;
    const context = this.#context;
    const browser = this.#browser;
    this.#page = undefined;
    this.#context = undefined;
    this.#browser = undefined;
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }

  #requirePage(): Page {
    if (!this.#page) throw new Error("The browser session is not open.");
    return this.#page;
  }

  async #readLabels(page: Page): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const labelLocators = page.locator("label[for]");
    const count = await labelLocators.count();
    for (let index = 0; index < count; index += 1) {
      const label = labelLocators.nth(index);
      const targetId = await label.getAttribute("for");
      const text = (await label.innerText()).trim();
      if (targetId && text) labels.set(targetId, text);
    }
    return labels;
  }

  async #observeElement(
    locator: Locator,
    labelMap: ReadonlyMap<string, string>,
    observationId: string,
  ): Promise<{ element: ObservedElement; entry: ElementRegistryEntry }> {
    const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
    const elementType = this.#elementType(tagName);
    const inputType = (await locator.getAttribute("type"))?.toLowerCase();
    const id = await locator.getAttribute("id");
    const label = id ? labelMap.get(id) : undefined;
    const testId = (await locator.getAttribute("data-testid")) ?? undefined;
    const semanticRole = this.#semanticRole(tagName, inputType, await locator.getAttribute("role"));
    const accessibleName = await this.#accessibleName(locator, semanticRole, label);
    const semanticTarget: SemanticTarget = {
      role: semanticRole,
      accessibleName,
      ...(label ? { label } : {}),
      ...(testId ? { testId } : {}),
    };
    const metadata = await this.#elementMetadata(locator, inputType, testId);
    const elementRef = `element-${String(this.#nextElementNumber).padStart(3, "0")}`;
    this.#nextElementNumber += 1;
    const availableOptions = [];
    if (tagName === "select") {
      const options = locator.locator("option");
      const selectedValue = await locator.inputValue();
      for (let index = 0; index < (await options.count()); index += 1) {
        const option = options.nth(index);
        const value = (await option.getAttribute("value")) ?? "";
        availableOptions.push({
          value,
          label: (await option.innerText()).trim(),
          selected: value === selectedValue,
          disabled: (await option.getAttribute("disabled")) !== null,
        });
      }
    }
    let currentValue: string | undefined;
    if (["input", "select", "textarea"].includes(tagName)) {
      currentValue = metadata.sensitive ? REDACTED_VALUE : await locator.inputValue();
    }
    const element: ObservedElement = {
      elementRef,
      semanticTarget,
      elementType,
      availableOptions,
      disabled: await locator.isDisabled(),
      controlOwner: metadata.owner,
      actionRisk: metadata.risk,
      sensitive: metadata.sensitive,
      ...(currentValue !== undefined ? { currentValue } : {}),
    };
    const href = (await locator.getAttribute("href")) ?? undefined;
    return {
      element,
      entry: {
        observationId,
        semanticTarget,
        controlOwner: metadata.owner,
        actionRisk: metadata.risk,
        ...(href ? { href } : {}),
      },
    };
  }

  #elementType(tagName: string): ObservedElement["elementType"] {
    if (tagName === "a") return "link";
    if (tagName === "button") return "button";
    if (tagName === "select") return "select";
    if (tagName === "textarea") return "textarea";
    return "input";
  }

  #semanticRole(
    tagName: string,
    inputType: string | undefined,
    explicitRole: string | null,
  ): SemanticRole {
    const parsedRole = explicitRole
      ? (["button", "link", "textbox", "combobox", "checkbox", "radio"] as const).find(
          (role) => role === explicitRole,
        )
      : undefined;
    if (parsedRole) return parsedRole;
    if (
      tagName === "button" ||
      (tagName === "input" && ["submit", "button"].includes(inputType ?? ""))
    ) {
      return "button";
    }
    if (tagName === "a") return "link";
    if (tagName === "select") return "combobox";
    if (inputType === "checkbox") return "checkbox";
    if (inputType === "radio") return "radio";
    return "textbox";
  }

  async #accessibleName(
    locator: Locator,
    role: SemanticRole,
    label: string | undefined,
  ): Promise<string> {
    if (label) return label;
    const ariaLabel = await locator.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    if (role === "button" || role === "link") {
      return (await locator.innerText()).trim() || ((await locator.getAttribute("value")) ?? "");
    }
    return (await locator.getAttribute("placeholder")) ?? "";
  }

  async #elementMetadata(
    locator: Locator,
    inputType: string | undefined,
    testId: string | undefined,
  ): Promise<ElementMetadata> {
    const declaredOwner = await locator.getAttribute("data-control-owner");
    const declaredRisk = await locator.getAttribute("data-action-risk");
    const explicitlySensitive = (await locator.getAttribute("data-sensitive")) === "true";
    const sensitive =
      explicitlySensitive || inputType === "password" || declaredRisk === "SENSITIVE";

    const classification = this.#policy.classifyControl({
      declaredOwner,
      declaredRisk,
      ...(testId ? { testId } : {}),
    });
    return {
      owner: classification.controlOwner,
      risk: classification.actionRisk,
      sensitive,
    };
  }

  #resolveSemanticTarget(page: Page, target: SemanticTarget): Locator {
    if (target.label) return page.getByLabel(target.label, { exact: true });
    if (target.testId) return page.getByTestId(target.testId);
    return page.getByRole(target.role, {
      name: target.accessibleName,
      exact: true,
    });
  }

  #policyResult(decision: PolicyDecision): SurfaceActionResult {
    return {
      status: decision.disposition === "REQUIRE_INTERVENTION" ? "HANDOFF_REQUIRED" : "BLOCKED",
      message: decision.reason,
      ...(this.#lastObservation ? { observation: this.#lastObservation } : {}),
    };
  }
}
