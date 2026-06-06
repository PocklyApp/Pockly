/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pockly landing page v2 — redesigned via Claude Design.
 *
 * Faithful port of "Pockly Landing v2.html": a 4-page snap-scroll site
 * (Hero · Features · How it works · Install + Footer) with page dots,
 * keyboard nav, a phone/terminal "turntable" in the hero, and the
 * local-setup narrative (install script → sign in to connect this
 * computer → scan a QR to join on your phone). All components live here;
 * App.tsx mounts <LandingPageV2/> for the publicLanding route.
 */
import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "./components/layout/theme-toggle";

// ─── Minimal shared types (mirrors the subset used from App.tsx) ──────────────
type AuthStatus = "loading" | "anonymous" | "authenticated";
interface LandingAuth {
  status: AuthStatus;
}
interface LandingRoute {
  view: string;
}
type Navigate = (r: LandingRoute) => void;

// Page order inside the snap-container.
const PAGE_HERO = 0;
const PAGE_FEATURES = 1;
const PAGE_HOW = 2;
const PAGE_INSTALL = 3;
const PAGE_COUNT = 4;

// =============================================================================
//  Icons  (Lucide-style 24×24 stroke, 1.6 weight)
// =============================================================================
function Icon({
  size = 20,
  children,
  className,
}: {
  size?: number | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

const IconCopy = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
);
const IconCheck = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 12.5l5 5 11-11" />
  </Icon>
);
const IconDownload = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14" />
  </Icon>
);
const IconSend = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 12l16-8-6 18-3-7-7-3z" />
  </Icon>
);
const IconActivity = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </Icon>
);
const IconLock = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);
const IconLayers = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
    <path d="M3 18l9 5 9-5" />
  </Icon>
);

// =============================================================================
//  Brand mark
// =============================================================================
export function BrandMark({ size = 38 }: { size?: number }) {
  return (
    <span
      className="brand-mark"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M690 168H362C256 168 170 254 170 360V664C170 770 256 856 362 856H662C768 856 854 770 854 664V444"
          stroke="#f7f7f2"
          strokeWidth="54"
          strokeLinecap="round"
        />
        <path
          d="M356 421L447 512L356 603"
          stroke="#f7f7f2"
          strokeWidth="52"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M526 614H690" stroke="#f7f7f2" strokeWidth="56" strokeLinecap="round" />
        <path
          d="M690 279C732 256 773 245 819 241"
          stroke="#f7f7f2"
          strokeWidth="26"
          strokeLinecap="round"
          strokeDasharray="2 48"
        />
        <circle cx="846" cy="240" r="58" fill="none" stroke="#f7f7f2" strokeWidth="38" />
      </svg>
    </span>
  );
}

// =============================================================================
//  Next-page pill (bottom-right of each snap page)
// =============================================================================
function NextPill({ label, onNext }: { label: string; onNext: () => void }) {
  return (
    <div className="landing-page-next-bottom">
      <button type="button" className="landing-page-next-link" onClick={onNext}>
        {label} →
      </button>
    </div>
  );
}

// =============================================================================
//  Site Header
// =============================================================================
export function LandingSiteHeader({
  auth,
  onNavigate,
  activePage = 0,
  onScrollToPage,
}: {
  route?: LandingRoute;
  auth: LandingAuth;
  onNavigate: Navigate;
  activePage?: number;
  onScrollToPage?: (index: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const nextLocale = i18n.language === "zh-CN" ? "en" : "zh-CN";
  const localeLabel = nextLocale === "zh-CN" ? "中文" : "EN";

  return (
    <header className="landing-site-header">
      <button
        type="button"
        className="brand landing-brand"
        onClick={() => onScrollToPage?.(PAGE_HERO)}
        aria-label={t("public.landingV2.header.homeAria")}
      >
        <BrandMark />
        <span className="brand-text">
          <strong>Pockly</strong>
          <small>{t("public.landingV2.brandSubtitle")}</small>
        </span>
      </button>

      <nav aria-label={t("public.landingV2.header.sectionsAria")}>
        <button
          type="button"
          className={activePage === PAGE_FEATURES ? "is-active" : ""}
          onClick={() => onScrollToPage?.(PAGE_FEATURES)}
        >
          {t("public.landingV2.nav.features")}
        </button>
        <button
          type="button"
          className={activePage === PAGE_HOW ? "is-active" : ""}
          onClick={() => onScrollToPage?.(PAGE_HOW)}
        >
          {t("public.landingV2.nav.howItWorks")}
        </button>
        <button
          type="button"
          onClick={() => onNavigate({ view: "publicDocs" })}
        >
          {t("public.nav.docs")}
        </button>
        <button
          type="button"
          onClick={() => onNavigate({ view: "publicChangelog" })}
        >
          {t("public.nav.changelog")}
        </button>
      </nav>

      <div className="landing-header-actions">
        <button
          type="button"
          className="landing-locale-toggle"
          onClick={() => void i18n.changeLanguage(nextLocale)}
          aria-label={t("public.landingV2.header.localeAria")}
          title={localeLabel}
        >
          {localeLabel}
        </button>
        <ThemeToggle />
        <button
          type="button"
          className="landing-header-download"
          onClick={() => onScrollToPage?.(PAGE_INSTALL)}
          aria-label={t("public.landingV2.header.downloadAria")}
        >
          <IconDownload size={16} />
          {t("public.landingV2.header.download")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            onNavigate(
              auth.status === "authenticated"
                ? { view: "workspaceSessions" }
                : { view: "login" }
            )
          }
        >
          {auth.status === "authenticated"
            ? t("public.actions.openWorkspace")
            : t("public.actions.signIn")}
        </button>
      </div>
    </header>
  );
}

// =============================================================================
//  Terminal animation
// =============================================================================
function terminalScript(t: (key: string) => string) {
  return [
    { cls: "user", text: "$ claude" },
    { cls: "dim", text: t("public.landingV2.terminal.versionLine") },
    { cls: "dim", text: t("public.landingV2.terminal.linkedLine") },
    { cls: "dim", text: "" },
    { cls: "user", text: t("public.landingV2.terminal.promptLine") },
    { cls: "tool", text: t("public.landingV2.terminal.readLine") },
    { cls: "tool", text: t("public.landingV2.terminal.grepLine") },
    { cls: "muted", text: t("public.landingV2.terminal.planLine") },
    { cls: "tool", text: t("public.landingV2.terminal.editLine") },
    { cls: "ok", text: t("public.landingV2.terminal.patchLine") },
    { cls: "tool", text: t("public.landingV2.terminal.testLine") },
    { cls: "ok", text: t("public.landingV2.terminal.testPassedLine") },
    { cls: "muted", text: "" },
    { cls: "dim", text: t("public.landingV2.terminal.handoffLine") },
  ] as const;
}

function Terminal({ paused = false }: { paused?: boolean }) {
  const { t } = useTranslation();
  const script = useMemo(() => terminalScript(t), [t]);
  const [shown, setShown] = useState(0);
  const [partial, setPartial] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return undefined;
    if (shown >= script.length) {
      const timer = setTimeout(() => {
        setShown(0);
        setPartial("");
      }, 4500);
      return () => clearTimeout(timer);
    }
    const line = script[shown];
    if (partial.length < line.text.length) {
      const delay = line.cls === "tool" || line.cls === "ok" ? 7 : 14;
      const timer = setTimeout(
        () => setPartial(line.text.slice(0, partial.length + 1)),
        delay
      );
      return () => clearTimeout(timer);
    }
    const hold =
      line.cls === "muted" && !line.text
        ? 250
        : line.cls === "tool"
        ? 360
        : 220;
    const timer = setTimeout(() => {
      setShown(shown + 1);
      setPartial("");
    }, hold);
    return () => clearTimeout(timer);
  }, [shown, partial, script, paused]);

  useEffect(() => {
    if (bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [shown, partial]);

  return (
    <div
      className="landing-endpoint landing-mac"
      role="img"
      aria-label={t("public.landingV2.terminal.aria")}
    >
      <div className="landing-mac-titlebar">
        <div className="landing-traffic">
          <span />
          <span />
          <span />
        </div>
        <div className="landing-mac-title">claude — relay-svc</div>
        <div className="landing-mac-meta">dev-mbp</div>
      </div>
      <div className="landing-terminal" ref={bodyRef}>
        {script.slice(0, shown).map((l, i) => (
          <div key={i} className={`landing-tline ${l.cls}`}>
            {l.text || " "}
          </div>
        ))}
        {shown < script.length && (
          <div className={`landing-tline ${script[shown].cls}`}>
            {partial}
            <span className="landing-cursor" />
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
//  iOS status-bar glyphs
// =============================================================================
function IosSignal() {
  return (
    <svg width="15" height="9" viewBox="0 0 15 9" fill="currentColor">
      <rect x="0" y="6" width="2.4" height="3" rx="0.6" />
      <rect x="3.6" y="4" width="2.4" height="5" rx="0.6" />
      <rect x="7.2" y="2" width="2.4" height="7" rx="0.6" />
      <rect x="10.8" y="0" width="2.4" height="9" rx="0.6" />
    </svg>
  );
}
function IosWifi() {
  return (
    <svg
      width="13"
      height="9"
      viewBox="0 0 13 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <path d="M1 3.2C2.6 1.8 4.5 1 6.5 1s3.9.8 5.5 2.2" />
      <path d="M3 5.2c1-.8 2.2-1.4 3.5-1.4s2.5.6 3.5 1.4" />
      <circle cx="6.5" cy="7.5" r="0.8" fill="currentColor" />
    </svg>
  );
}
function IosBattery() {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" fill="none">
      <rect x="0.5" y="0.5" width="18" height="9" rx="2" stroke="currentColor" opacity="0.5" />
      <rect x="2" y="2" width="11" height="6" rx="1" fill="currentColor" />
      <rect x="19.5" y="3" width="1.6" height="4" rx="0.5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

// =============================================================================
//  Phone preview animation — mirrors the real .agent-conversation-header
// =============================================================================
function PhonePreview() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const fullText = t("public.landingV2.phone.assistantText");

  useEffect(() => {
    let i = 0;
    let active = true;
    const tick = () => {
      if (!active) return;
      if (i <= fullText.length) {
        setText(fullText.slice(0, i));
        i += 1;
        setTimeout(tick, 22);
      } else {
        setTimeout(() => {
          if (active) {
            i = 0;
            setText("");
            setTimeout(tick, 200);
          }
        }, 4200);
      }
    };
    tick();
    return () => {
      active = false;
    };
  }, [fullText]);

  return (
    <div
      className="landing-phone-frame"
      role="img"
      aria-label={t("public.landingV2.phone.aria")}
    >
      <div className="landing-phone-screen">
        <span className="landing-phone-camera" />
        <div className="landing-phone-statusbar">
          <span>{t("public.landingV2.phone.time")}</span>
          <span className="landing-statusbar-icons">
            <IosSignal />
            <IosWifi />
            <IosBattery />
          </span>
        </div>

        <div className="landing-app-header">
          <span className="landing-crumb">
            <span className="landing-crumb-dot" />
            <strong>Pockly</strong>
            <span className="landing-crumb-proj">/ relay-svc</span>
          </span>
          <span className="landing-btn-soft" aria-hidden="true">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
              <circle cx="5" cy="12" r="1" />
            </svg>
          </span>
        </div>

        <div className="landing-session-card">
          <div className="landing-conv-main">
            <h2 className="landing-conv-title">{t("public.landingV2.phone.sessionName")}</h2>
            <div className="landing-conv-meta">
              <span className="landing-conv-live">{t("public.landingV2.phone.convLive")}</span>
              <span>{t("public.landingV2.phone.convAgent")}</span>
              <span>{t("public.landingV2.phone.convTime")}</span>
            </div>
          </div>
        </div>

        <div className="landing-assistant-bubble">
          <div className="landing-bubble-who">{t("public.landingV2.phone.assistantLabel")}</div>
          <span>
            {text}
            <span className="landing-cursor-dark" />
          </span>
        </div>

        <div className="landing-composer">
          <input placeholder={t("public.landingV2.phone.composerPlaceholder")} readOnly />
          <button className="landing-btn-send" aria-label={t("common.send")}>
            <IconSend size={13} />
          </button>
        </div>

        <span className="landing-phone-home" />
      </div>
    </div>
  );
}

// =============================================================================
//  Install targets — verbatim from the connect-wizard
// =============================================================================
function installTargets(t: (key: string) => string) {
  return [
    {
      id: "unix",
      label: t("public.landingV2.installTargets.unix"),
      prompt: "$",
      cmd: "curl -fsSL https://cdn.pockly.example/install.sh | bash",
    },
    {
      id: "win",
      label: t("public.landingV2.installTargets.windowsShort"),
      prompt: "PS",
      cmd: "irm https://cdn.pockly.example/install.ps1 | iex",
    },
  ];
}

function bandInstallTargets(t: (key: string) => string) {
  return [
    {
      id: "unix",
      label: t("public.landingV2.installTargets.unix"),
      prompt: "$",
      cmd: "curl -fsSL https://cdn.pockly.example/install.sh | bash",
    },
    {
      id: "win",
      label: t("public.landingV2.installTargets.windows"),
      prompt: "PS",
      cmd: "irm https://cdn.pockly.example/install.ps1 | iex",
    },
  ];
}

// =============================================================================
//  Hero — copy + phone/terminal turntable
// =============================================================================
function Hero({
  onNavigate,
  onNext,
}: {
  onNavigate: Navigate;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const targets = installTargets(t);
  const [target, setTarget] = useState("unix");
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [autoRotated, setAutoRotated] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = targets.find((item) => item.id === target) ?? targets[0]!;

  // Plain function (not memoized) — only referenced by event handlers, never
  // an effect dependency, so it won't churn the idle timer on re-render.
  const startIdleTimer = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setAutoRotated(true), 30000);
  };

  // Arm the 30s auto-rotate once on mount.
  useEffect(() => {
    const timer = setTimeout(() => setAutoRotated(true), 30000);
    idleTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, []);

  const onCopy = () => {
    navigator.clipboard?.writeText(active.cmd).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const showTerminal = hovered || autoRotated;

  return (
    <section className="landing-hero landing-container" id="top">
      {/* ── Left: copy + install widget ── */}
      <div className="landing-hero-copy">
        <span className="landing-eyebrow">{t("public.landingV2.hero.eyebrow")}</span>
        <h1>
          {t("public.landingV2.hero.title")}{" "}
          <span>{t("public.landingV2.hero.titleAccent")}</span>
        </h1>
        <p className="landing-hero-lead">{t("public.landingV2.hero.body")}</p>

        <div className="landing-install-block" role="group" aria-label={t("public.landingV2.hero.installAria")}>
          <div className="landing-install-tabs" role="tablist">
            {targets.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={target === item.id}
                className={`landing-install-tab${target === item.id ? " is-active" : ""}`}
                onClick={() => {
                  setTarget(item.id);
                  setCopied(false);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="landing-install-cmd">
            <span className="landing-prompt">{active.prompt}</span>
            <code>{active.cmd}</code>
            <button
              className={`landing-btn-copy${copied ? " copied" : ""}`}
              onClick={onCopy}
              aria-label={t("public.landingV2.hero.copyInstallAria")}
            >
              {copied ? (
                <>
                  <IconCheck size={12} />
                  {t("common.copied").toLowerCase()}
                </>
              ) : (
                <>
                  <IconCopy size={12} />
                  {t("common.copy").toLowerCase()}
                </>
              )}
            </button>
          </div>
          <div className="landing-install-hint">{t("public.landingV2.hero.installHint")}</div>
        </div>

        <div className="landing-hero-meta">
          <span>{t("public.landingV2.hero.platforms")}</span>
          <span className="landing-meta-dot" />
          <span>{t("public.landingV2.hero.runsLocal")}</span>
          <span className="landing-meta-dot" />
          <button
            type="button"
            className="landing-docs-link"
            onClick={() => onNavigate({ view: "publicDocs" })}
          >
            {t("public.landingV2.hero.readDocs")}
          </button>
        </div>
      </div>

      {/* ── Right: phone-front / terminal-behind turntable ── */}
      <div className="landing-bridge-stage">
        <div
          className={`landing-turntable${showTerminal ? " show-terminal" : ""}`}
          onMouseEnter={() => {
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            setHovered(true);
            setAutoRotated(false);
          }}
          onMouseLeave={() => {
            setHovered(false);
            startIdleTimer();
          }}
          onClick={() => {
            setHovered(false);
            startIdleTimer();
            setAutoRotated((prev) => !prev);
          }}
        >
          <div className="landing-turntable-phone">
            <PhonePreview />
          </div>
          <div className="landing-turntable-terminal">
            <Terminal />
          </div>
        </div>
      </div>

      <NextPill label={t("public.landingV2.next.details")} onNext={onNext} />
    </section>
  );
}

// =============================================================================
//  Feature grid
// =============================================================================
function features(t: (key: string) => string) {
  return [
    {
      icon: <IconActivity size={18} />,
      title: t("public.landingV2.features.watch.title"),
      body: t("public.landingV2.features.watch.body"),
      tag: t("public.landingV2.features.watch.tag"),
    },
    {
      icon: <IconSend size={18} />,
      title: t("public.landingV2.features.steer.title"),
      body: t("public.landingV2.features.steer.body"),
      tag: t("public.landingV2.features.steer.tag"),
    },
    {
      icon: <IconLock size={18} />,
      title: t("public.landingV2.features.private.title"),
      body: t("public.landingV2.features.private.body"),
      tag: t("public.landingV2.features.private.tag"),
    },
    {
      icon: <IconLayers size={18} />,
      title: t("public.landingV2.features.hosts.title"),
      body: t("public.landingV2.features.hosts.body"),
      tag: t("public.landingV2.features.hosts.tag"),
    },
  ];
}

function FeatureGrid({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const items = features(t);
  return (
    <section className="landing-section landing-container" id="features">
      <div className="landing-section-head">
        <span className="landing-eyebrow">{t("public.landingV2.featureSection.eyebrow")}</span>
        <h2>{t("public.landingV2.featureSection.title")}</h2>
        <p>
          {t("public.landingV2.featureSection.bodyPrefix")}{" "}
          <em>{t("public.landingV2.featureSection.bodyEmphasis")}</em>{" "}
          {t("public.landingV2.featureSection.bodySuffix")}
        </p>
      </div>
      <div className="landing-features">
        {items.map((f) => (
          <article key={f.title} className="landing-feature">
            <span className="landing-feature-icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            <span className="landing-feature-tag">{f.tag}</span>
          </article>
        ))}
      </div>
      <NextPill label={t("public.landingV2.nav.howItWorks")} onNext={onNext} />
    </section>
  );
}

// =============================================================================
//  How it works — local setup (install → sign in → scan QR)
// =============================================================================
const PAIR_STATES = ["waiting", "scanned", "streaming"] as const;

function HowItWorks({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      () => setActive((a) => (a + 1) % PAIR_STATES.length),
      3200
    );
    return () => clearInterval(timer);
  }, []);

  const pairState = PAIR_STATES[active] ?? "waiting";

  return (
    <section className="landing-section landing-container" id="how">
      <div className="landing-section-head">
        <span className="landing-eyebrow">{t("public.landingV2.how.eyebrow")}</span>
        <h2>{t("public.landingV2.how.title")}</h2>
        <p>{t("public.landingV2.how.body")}</p>
      </div>
      <div className="landing-steps" data-pair-state={pairState}>
        {/* Step 1 — run the install script */}
        <div className={`landing-step${active === 0 ? " is-active" : ""}`}>
          <span className="landing-step-num">01</span>
          <h3>{t("public.landingV2.how.step1.title")}</h3>
          <p>{t("public.landingV2.how.step1.body")}</p>
          <div className="landing-step-cmd">
            <span className="landing-prompt">$ </span>
            curl -fsSL https://cdn.pockly.example/install.sh | bash
          </div>
        </div>

        {/* Step 2 — sign in to connect this computer (browser auth card) */}
        <div className={`landing-step${active === 1 ? " is-active" : ""}`}>
          <span className="landing-step-num">02</span>
          <h3>{t("public.landingV2.how.step2.title")}</h3>
          <p>{t("public.landingV2.how.step2.body")}</p>
          <div className="landing-auth-card" role="status" aria-live="polite">
            <div className="landing-auth-head">
              <span className="landing-auth-dot" aria-hidden="true" />
              <span>{t("public.landingV2.how.step2.authHost")}</span>
            </div>
            <div>
              <div className="landing-auth-q">{t("public.landingV2.how.step2.authQ")}</div>
              <div className="landing-auth-dev">cursor-mbp.local · daemon v0.6</div>
            </div>
            <button type="button" className="landing-auth-btn">
              <span className="landing-auth-btn-label">{t("public.landingV2.how.step2.authBtn")}</span>
              <span className="landing-auth-btn-done">
                <IconCheck size={12} /> {t("public.landingV2.how.step2.authDone")}
              </span>
            </button>
          </div>
        </div>

        {/* Step 3 — open Pockly on your phone (scan a QR, password-free) */}
        <div className={`landing-step${active === 2 ? " is-active" : ""}`}>
          <span className="landing-step-num">03</span>
          <h3>{t("public.landingV2.how.step3.title")}</h3>
          <p>{t("public.landingV2.how.step3.body")}</p>
          <div className="landing-join-qr-card" role="status" aria-live="polite">
            <span className="landing-join-qr" aria-hidden="true" />
            <span className="landing-join-qr-meta">
              <span className="landing-join-qr-title">{t("public.landingV2.how.step3.qrTitle")}</span>
              <span className="landing-join-qr-sub">{t("public.landingV2.how.step3.qrSub")}</span>
            </span>
          </div>
        </div>
      </div>
      <NextPill label={t("public.landingV2.install.eyebrow")} onNext={onNext} />
    </section>
  );
}

// =============================================================================
//  Install CTA (dark band)
// =============================================================================
function InstallCTA() {
  const { t } = useTranslation();
  const targets = bandInstallTargets(t);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copy = (id: string, cmd: string) => {
    navigator.clipboard?.writeText(cmd).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  };

  return (
    <section className="landing-install-band" id="install">
      <div className="landing-container">
        <div>
          <span className="landing-eyebrow landing-band-eyebrow">{t("public.landingV2.install.eyebrow")}</span>
          <h2>{t("public.landingV2.install.title")}</h2>
          <p>{t("public.landingV2.install.body")}</p>
          <div className="landing-band-checks">
            <span>
              <IconCheck size={12} /> {t("public.landingV2.install.check1")}
            </span>
            <span>
              <IconCheck size={12} /> {t("public.landingV2.install.check2")}
            </span>
            <span>
              <IconCheck size={12} /> {t("public.landingV2.install.check3")}
            </span>
          </div>
        </div>

        <div className="landing-install-stack" aria-label={t("public.landingV2.install.commandsAria")}>
          {targets.map((item) => (
            <div key={item.id} className="landing-install-card">
              <div className="landing-install-card-head">
                <span className="landing-install-card-label">{item.label}</span>
                <button
                  className="landing-copy-mini"
                  onClick={() => copy(item.id, item.cmd)}
                  aria-label={t("public.landingV2.install.copyCommandAria", { label: item.label })}
                >
                  {copiedId === item.id ? (
                    <>
                      <IconCheck size={11} />
                      {t("common.copied").toLowerCase()}
                    </>
                  ) : (
                    <>
                      <IconCopy size={11} />
                      {t("common.copy").toLowerCase()}
                    </>
                  )}
                </button>
              </div>
              <div className="landing-install-card-line">
                <span className="landing-prompt">{item.prompt}</span>
                <code>{item.cmd}</code>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// =============================================================================
//  Site footer
// =============================================================================
function SiteFooter({
  onNavigate,
  onScrollToPage,
}: {
  onNavigate: Navigate;
  onScrollToPage: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <footer className="landing-site-footer">
      <div className="landing-container landing-footer-grid">
        <button
          type="button"
          className="brand landing-brand"
          onClick={() => onScrollToPage(PAGE_HERO)}
          aria-label={t("public.landingV2.header.homeAria")}
        >
          <BrandMark />
          <span className="brand-text">
            <strong>Pockly</strong>
            <small>{t("public.landingV2.brandSubtitle")}</small>
          </span>
        </button>
        <nav aria-label={t("public.landingV2.footer.navAria")}>
          <button type="button" onClick={() => onScrollToPage(PAGE_FEATURES)}>
            {t("public.landingV2.nav.features")}
          </button>
          <button type="button" onClick={() => onScrollToPage(PAGE_HOW)}>
            {t("public.landingV2.nav.howItWorks")}
          </button>
          <button type="button" onClick={() => onNavigate({ view: "publicDocs" })}>
            {t("public.nav.docs")}
          </button>
          <button type="button" onClick={() => onNavigate({ view: "publicChangelog" })}>
            {t("public.nav.changelog")}
          </button>
        </nav>
        <span className="landing-footer-built">{t("public.landingV2.footer.tagline")}</span>
      </div>
    </footer>
  );
}

// =============================================================================
//  Main exported landing page — owns the snap-scroll shell
// =============================================================================
export function LandingPageV2({
  auth,
  onNavigate,
}: {
  auth: LandingAuth;
  onNavigate: Navigate;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(0);

  const scrollToPage = useCallback((index: number) => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.children[index] as HTMLElement | undefined;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setCurrentPage(index);
    }
  }, []);

  // Track current page from scroll position.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const onScroll = () => {
      const idx = Math.round(container.scrollTop / container.clientHeight);
      setCurrentPage((prev) => (idx !== prev ? idx : prev));
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Keyboard navigation (up / down arrows).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const c = containerRef.current;
      if (!c) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const idx = Math.round(c.scrollTop / c.clientHeight);
      if (e.key === "ArrowDown" && idx < PAGE_COUNT - 1) {
        e.preventDefault();
        scrollToPage(idx + 1);
      }
      if (e.key === "ArrowUp" && idx > 0) {
        e.preventDefault();
        scrollToPage(idx - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scrollToPage]);

  return (
    <>
      <LandingSiteHeader
        auth={auth}
        onNavigate={onNavigate}
        activePage={currentPage}
        onScrollToPage={scrollToPage}
      />

      <div className="landing-snap-container" ref={containerRef}>
        <div className="landing-snap-page landing-page-hero">
          <Hero onNavigate={onNavigate} onNext={() => scrollToPage(PAGE_FEATURES)} />
        </div>
        <div className="landing-snap-page landing-page-features">
          <FeatureGrid onNext={() => scrollToPage(PAGE_HOW)} />
        </div>
        <div className="landing-snap-page landing-page-how">
          <HowItWorks onNext={() => scrollToPage(PAGE_INSTALL)} />
        </div>
        <div className="landing-snap-page landing-page-install">
          <InstallCTA />
          <SiteFooter onNavigate={onNavigate} onScrollToPage={scrollToPage} />
        </div>
      </div>

      <div className="landing-page-dots" role="tablist" aria-label={t("public.landingV2.pagesAria")}>
        {Array.from({ length: PAGE_COUNT }, (_, i) => (
          <button
            key={i}
            type="button"
            className={`landing-page-dot${currentPage === i ? " active" : ""}`}
            role="tab"
            aria-selected={currentPage === i}
            aria-label={t("public.landingV2.pageLabel", { n: i + 1 })}
            onClick={() => scrollToPage(i)}
          />
        ))}
      </div>
    </>
  );
}
