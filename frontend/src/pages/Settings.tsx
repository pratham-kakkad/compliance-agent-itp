import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Clock, Earth, Laptop, Mail, RotateCcw, Search, Send, type LucideIcon } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useCompliance } from "../lib/ComplianceContext";
import { useSettings, useTimezoneList } from "../lib/SettingsContext";
import type { SmtpSettings } from "../types";
import {
  browserTimeZone,
  fmtDateTime,
  fmtZonedDate,
  fmtZonedTime,
  isSupportedTimeZone,
  utcOffsetLabel,
} from "../lib/format";
import { Banner, Button, Card, Label, PageHeader, Select, TextInput } from "../components/ui";
import { Field } from "../components/compliance/common";
import { PasswordField } from "../components/auth/PasswordField";
import { TimezoneSelect, visibleTimezoneGroups } from "../components/TimezoneSelect";
import { notify } from "../components/shell/toast";

/**
 * ICU (Chrome, Edge, Node) still reports these zones by their legacy IDs, e.g.
 * "Asia/Calcutta" for India. The server lists both names; suggest the modern one.
 */
const LEGACY_ZONE_NAMES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "America/Godthab": "America/Nuuk",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Indianapolis": "America/Indiana/Indianapolis",
};

/** The browser's canonical ID for a zone, so aliases (Asia/Kolkata, Asia/Calcutta) compare equal. */
function canonicalZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return timeZone;
  }
}

/** Two names for the same zone (an alias and its modern name count as the same). */
function sameZone(a: string, b: string): boolean {
  return a === b || canonicalZone(a) === canonicalZone(b);
}

/** Re-renders every `ms` so live clocks tick. */
function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * One card on the Settings page: what the setting is on the left, its controls
 * on the right, and an optional footer (status + actions) underneath.
 */
function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  children,
  footer,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const headingId = `settings-${id}-heading`;
  return (
    <section id={`settings-${id}`} aria-labelledby={headingId} className="scroll-mt-20">
      <Card padding="none" className="overflow-hidden">
        <div className="grid md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] gap-x-8 gap-y-4 p-4 sm:p-5">
          <div className="flex items-start gap-3 min-w-0">
            <span className="w-8 h-8 rounded-md bg-panel2 border border-line flex items-center justify-center text-ink2 flex-none">
              <Icon size={16} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 id={headingId} className="text-sm font-semibold text-ink leading-5">
                {title}
              </h2>
              <p className="text-[13px] text-ink2 mt-0.5 leading-[18px]">{description}</p>
            </div>
          </div>
          <div className="min-w-0">{children}</div>
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3 border-t border-line bg-panel2">
            {footer}
          </div>
        )}
      </Card>
    </section>
  );
}

function TimeZoneSection() {
  const { settings, update } = useSettings();
  const { data: list, error: listError, reload: reloadList } = useTimezoneList();
  const saved = settings.timezone;
  const [draft, setDraft] = useState(saved);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const now = useNow(1000);
  const uid = useId();
  const selectId = `${uid}-tz`;
  const filterId = `${uid}-tz-filter`;
  const helpId = `${uid}-tz-help`;
  const countId = `${uid}-tz-count`;

  // If the saved zone changes underneath (a reload picked up someone else's change), follow it.
  useEffect(() => setDraft(saved), [saved]);

  const dirty = draft !== saved;
  const names = useMemo(() => new Set(list?.timezones.map((t) => t.name) ?? []), [list]);
  const matches = useMemo(() => {
    if (!list || !query.trim()) return null;
    // The first match in on-screen (grouped) order, so Enter picks the top visible option.
    return visibleTimezoneGroups(list.timezones, "", query).flatMap((g) => g.options);
  }, [list, query]);

  const browser = browserTimeZone();
  const modern = browser ? LEGACY_ZONE_NAMES[browser] : undefined;
  const browserZone = modern && names.has(modern) ? modern : browser;
  // Hidden when the browser is already on the picked zone under another name (Asia/Calcutta vs Asia/Kolkata).
  const browserSuggestion = browserZone && names.has(browserZone) && !sameZone(browserZone, draft) ? browserZone : null;
  const defaultZone = settings.default_timezone;
  const defaultSuggestion = defaultZone && names.has(defaultZone) && !sameZone(defaultZone, draft) ? defaultZone : null;

  const pick = (tz: string) => {
    setDraft(tz);
    setError(null);
  };

  const reset = () => {
    setDraft(saved);
    setQuery("");
    setError(null);
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await update({ timezone: draft });
      if (r.changed) {
        const days = r.recomputed_days;
        notify.success(
          "Time zone saved",
          `Times now show in ${r.timezone}. Recalculated ${days.toLocaleString()} attendance day${days === 1 ? "" : "s"}.`
        );
      } else {
        notify.info("Time zone unchanged", `${r.timezone} was already the saved time zone.`);
      }
      // A changed zone remounts this page (see AppLayout), which resets the draft to the new saved value.
    } catch (err) {
      const msg = err instanceof Error ? err.message : "The time zone couldn't be saved.";
      setError(msg);
      notify.error("Couldn't save the time zone", msg);
    } finally {
      setSaving(false);
    }
  };

  const previewable = isSupportedTimeZone(draft);

  const footer = (
    <>
      <p className="text-xs text-ink2 min-w-0">
        {settings.updated_at && settings.updated_by ? (
          <>
            Last changed by <span className="font-medium text-ink">{settings.updated_by}</span> on{" "}
            <time dateTime={settings.updated_at}>{fmtDateTime(settings.updated_at)}</time>
          </>
        ) : settings.updated_at ? (
          <>
            Last changed on <time dateTime={settings.updated_at}>{fmtDateTime(settings.updated_at)}</time>
          </>
        ) : (
          <>Not changed yet — using the default ({defaultZone}).</>
        )}
      </p>
      <div className="flex items-center gap-2 ml-auto">
        <Button leadingIcon={RotateCcw} onClick={reset} disabled={!dirty || saving}>
          Reset
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty} loading={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </>
  );

  return (
    <form onSubmit={save} noValidate>
      <SettingsSection
        id="timezone"
        icon={Earth}
        title="Time zone"
        description="The organization's time zone for displaying times and assigning punches to days."
        footer={footer}
      >
        <label htmlFor={selectId} className="block text-[13px] font-medium text-ink mb-1.5">
          Organization time zone
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <TextInput
            id={filterId}
            type="text"
            role="searchbox"
            enterKeyHint="search"
            leadingIcon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Enter picks the top match instead of submitting the form.
                e.preventDefault();
                if (matches?.length) pick(matches[0].name);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                selectRef.current?.focus();
              } else if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Filter by city, region or offset"
            aria-label="Filter time zones"
            aria-controls={selectId}
            aria-describedby={query ? countId : undefined}
            autoComplete="off"
            className="sm:w-60 flex-none"
          />
          <TimezoneSelect
            ref={selectRef}
            id={selectId}
            value={draft}
            onChange={pick}
            timezones={list?.timezones}
            query={query}
            disabled={saving}
            aria-describedby={helpId}
            className="w-full min-w-0 flex-1"
          />
        </div>
        <p id={countId} className="sr-only" aria-live="polite">
          {matches ? `${matches.length} time zone${matches.length === 1 ? "" : "s"} match` : ""}
        </p>
        {matches && matches.length === 0 && (
          <p className="text-xs text-ink2 mt-1.5">No time zones match “{query.trim()}”.</p>
        )}
        {listError && (
          <p className="text-xs text-crit mt-1.5 flex flex-wrap items-center gap-2">
            The list of time zones couldn't be loaded ({listError.message}).
            <button type="button" onClick={reloadList} className="font-semibold text-accent hover:underline">
              Try again
            </button>
          </p>
        )}

        <p id={helpId} className="text-[13px] text-ink2 mt-3 leading-[19px]">
          Punch times are stored in UTC and shown everywhere in this time zone. It also decides which calendar day a
          punch counts toward, so saving a new time zone recalculates every attendance day.
        </p>

        {(browserSuggestion || defaultSuggestion) && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {browserSuggestion && (
              <Button size="sm" variant="outline" leadingIcon={Laptop} onClick={() => pick(browserSuggestion)} disabled={saving}>
                Use my browser's time zone ({browserSuggestion})
              </Button>
            )}
            {defaultSuggestion && (
              <Button size="sm" variant="ghost" onClick={() => pick(defaultSuggestion)} disabled={saving}>
                Use the default ({defaultSuggestion})
              </Button>
            )}
          </div>
        )}

        <div className="mt-4 flex items-start gap-3 rounded-lg border border-line bg-panel2 px-3 py-2.5">
          <Clock size={16} className="text-ink2 mt-0.5 flex-none" aria-hidden />
          <div className="min-w-0 text-[13px]">
            {previewable ? (
              <p className="text-ink2">
                Current time in <span className="font-medium text-ink">{draft}</span>:{" "}
                <time dateTime={now.toISOString()} className="font-semibold text-ink tabular whitespace-nowrap">
                  {fmtZonedDate(now, draft)} · {fmtZonedTime(now, draft)}
                </time>{" "}
                <span className="text-ink3 whitespace-nowrap">({utcOffsetLabel(draft, now)})</span>
              </p>
            ) : (
              <p className="text-ink2">This browser can't preview {draft}.</p>
            )}
            {dirty && isSupportedTimeZone(saved) && (
              <p className="text-xs text-ink3 mt-1">
                Saved time zone {saved}: {fmtZonedTime(now, saved)} ({utcOffsetLabel(saved, now)})
              </p>
            )}
          </div>
        </div>

        {dirty && (
          <Banner tone="warn" title="Saving recalculates attendance days" className="mt-4">
            Every attendance day is rebuilt from the stored punches in {draft}. Punches near midnight can move to the
            previous or next day.
          </Banner>
        )}

        {error && (
          <Banner tone="crit" title="The time zone wasn't saved" className="mt-4" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
      </SettingsSection>
    </form>
  );
}

// ------------------------------------------------------------ e-mail (SMTP)

type Security = SmtpSettings["security"];
const SECURITY_OPTIONS: { value: Security; label: string }[] = [
  { value: "starttls", label: "STARTTLS (usually port 587)" },
  { value: "ssl", label: "SSL / TLS (usually port 465)" },
  { value: "none", label: "None, not encrypted (usually port 25)" },
];
const DEFAULT_PORT: Record<Security, number> = { starttls: 587, ssl: 465, none: 25 };

function SmtpForm({ saved, onSaved }: { saved: SmtpSettings; onSaved: (s: SmtpSettings) => void }) {
  const { me } = useAuth();
  const uid = useId();
  const [host, setHost] = useState(saved.host);
  const [port, setPort] = useState(String(saved.port));
  const [security, setSecurity] = useState<Security>(saved.security);
  const [username, setUsername] = useState(saved.username);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [fromEmail, setFromEmail] = useState(saved.from_email);
  const [fromName, setFromName] = useState(saved.from_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState(me?.email ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const dirty =
    host.trim() !== saved.host ||
    portNum !== saved.port ||
    security !== saved.security ||
    username.trim() !== saved.username ||
    fromEmail.trim() !== saved.from_email ||
    fromName.trim() !== saved.from_name ||
    password !== "" ||
    clearPassword;
  const fromOk = fromEmail.trim() === "" || /^\S+@\S+$/.test(fromEmail.trim());

  function pickSecurity(next: Security) {
    // Follow the usual port for the mode, but never overwrite a port someone typed on purpose.
    if (Number(port) === DEFAULT_PORT[security]) setPort(String(DEFAULT_PORT[next]));
    setSecurity(next);
  }

  function discard() {
    setHost(saved.host);
    setPort(String(saved.port));
    setSecurity(saved.security);
    setUsername(saved.username);
    setFromEmail(saved.from_email);
    setFromName(saved.from_name);
    setPassword("");
    setClearPassword(false);
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!portOk || !fromOk) return;
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {
        host: host.trim(),
        port: portNum,
        security,
        username: username.trim(),
        from_email: fromEmail.trim(),
        from_name: fromName.trim(),
      };
      if (clearPassword) body.password = "";
      else if (password) body.password = password;
      const next = await api.put<SmtpSettings>("/settings/smtp", body);
      onSaved(next);
      notify.success("E-mail settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>("/settings/smtp/test", { to: testTo.trim() });
      setTestResult(
        r.ok
          ? { ok: true, text: `A test message is on its way to ${testTo.trim()}. Check that inbox (and spam).` }
          : { ok: false, text: r.error ?? "The message couldn't be sent." }
      );
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  const testDisabled = testing || dirty || !saved.configured || !/^\S+@\S+$/.test(testTo.trim());

  return (
    <>
      <form id={`${uid}-form`} onSubmit={(e) => void save(e)} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-wrap items-center gap-2">
          {saved.configured ? (
            <Label tone="good" dot>
              Configured
            </Label>
          ) : (
            <Label tone="warn" dot>
              Not configured
            </Label>
          )}
          {saved.source === "environment" && <span className="text-xs text-ink2">Using the server's SMTP_* environment values. Saving here overrides them.</span>}
        </div>
        {!saved.configured && (
          <p className="text-[13px] text-ink2 -mt-1">
            Until e-mail is set up, invites and password resets can't be mailed (you get a link to copy instead) and compliance reminders stay in the app.
          </p>
        )}

        <div className="grid sm:grid-cols-[minmax(0,1fr)_110px] gap-3">
          <Field label="SMTP host" hint="For example smtp.office365.com or smtp.gmail.com">
            {(id) => <TextInput id={id} value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" spellCheck={false} disabled={saving} />}
          </Field>
          <Field label="Port" error={portOk ? null : "1 to 65535"}>
            {(id) => <TextInput id={id} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} invalid={!portOk} disabled={saving} />}
          </Field>
        </div>

        <Field label="Security">
          {(id) => <Select id={id} value={security} onChange={(e) => pickSecurity(e.target.value as Security)} options={SECURITY_OPTIONS} className="w-full" disabled={saving} />}
        </Field>

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Username" hint="Leave empty if the server needs no login.">
            {(id) => <TextInput id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} disabled={saving} />}
          </Field>
          <Field
            label="Password"
            hint={
              clearPassword ? (
                "The saved password will be removed when you save."
              ) : saved.password_unreadable ? (
                <span className="text-warn">The saved password can't be read anymore (the server's session secret changed). Enter it again.</span>
              ) : saved.password_set ? (
                <>
                  <span className="text-good font-medium">Saved.</span> Leave empty to keep it.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setClearPassword(true);
                      setPassword("");
                    }}
                    className="text-accent hover:underline"
                  >
                    Remove it
                  </button>
                </>
              ) : (
                "Stored encrypted. It is never shown again."
              )
            }
          >
            {(id) => (
              <PasswordField
                id={id}
                size="md"
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  if (v) setClearPassword(false);
                }}
                autoComplete="new-password"
                placeholder={saved.password_set && !clearPassword ? "Saved" : ""}
                disabled={saving}
              />
            )}
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="From address" error={fromOk ? null : "Enter a valid e-mail address"} hint="Shown as the sender, e.g. no-reply@yourcompany.com">
            {(id) => <TextInput id={id} type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} invalid={!fromOk} placeholder="no-reply@company.com" autoComplete="off" disabled={saving} />}
          </Field>
          <Field label="From name">
            {(id) => <TextInput id={id} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Encop" autoComplete="off" disabled={saving} />}
          </Field>
        </div>

        {error && (
          <Banner tone="crit" title="The e-mail settings weren't saved" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        <div className="flex justify-end gap-2">
          {dirty && (
            <Button disabled={saving} onClick={discard}>
              Discard
            </Button>
          )}
          <Button type="submit" variant="primary" loading={saving} disabled={!dirty || !portOk || !fromOk}>
            Save e-mail settings
          </Button>
        </div>
      </form>

      <div className="mt-6 border-t border-line pt-4">
        <h3 className="text-[13px] font-semibold text-ink">Send a test e-mail</h3>
        <p className="text-xs text-ink2 mt-0.5">Sends a real message with the saved settings, so you see the exact error if something is wrong.</p>
        <div className="mt-2.5 flex flex-col sm:flex-row gap-2">
          <TextInput
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@company.com"
            aria-label="Send the test e-mail to"
            autoComplete="off"
            className="flex-1 min-w-0"
          />
          <Button leadingIcon={Send} loading={testing} disabled={testDisabled} onClick={() => void sendTest()}>
            Send test email
          </Button>
        </div>
        {dirty && <p className="text-xs text-ink3 mt-1.5">Save your changes first: the test uses the saved settings.</p>}
        {testResult && (
          <Banner tone={testResult.ok ? "good" : "crit"} title={testResult.ok ? "Test e-mail sent" : "The test e-mail failed"} className="mt-3">
            {testResult.text}
          </Banner>
        )}
      </div>
    </>
  );
}

function SmtpSection() {
  const { can, ready } = useCompliance();
  const allowed = ready && can("settings", "configure");
  const { data, error, reload } = useApi<SmtpSettings>(allowed ? "/settings/smtp" : null);
  const [override, setOverride] = useState<SmtpSettings | null>(null);
  const current = override ?? data;
  if (!allowed) return null;

  return (
    <SettingsSection
      id="smtp"
      icon={Mail}
      title="Email (SMTP)"
      description="The mail server Encop uses for invites, password resets and compliance reminders."
      footer={
        current?.updated_at ? (
          <p className="text-xs text-ink2">
            Last saved {fmtDateTime(current.updated_at)}
            {current.updated_by ? ` by ${current.updated_by}` : ""}
          </p>
        ) : undefined
      }
    >
      {error && !current ? (
        <Banner tone="warn" title="The e-mail settings couldn't be loaded" action={<Button size="sm" onClick={reload}>Try again</Button>}>
          {error.message}
        </Banner>
      ) : !current ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : (
        <SmtpForm key={`${current.updated_at}|${current.configured}`} saved={current} onSaved={setOverride} />
      )}
    </SettingsSection>
  );
}

/**
 * Every settings section, in page order. A new setting is one more entry here
 * plus a component that renders a <SettingsSection>.
 */
const SECTIONS: { id: string; Component: React.ComponentType }[] = [
  { id: "timezone", Component: TimeZoneSection },
  { id: "smtp", Component: SmtpSection },
];

export function Settings() {
  const { error, reload, timezone } = useSettings();

  // Pick up changes someone else made since the app booted (also retries a failed boot load).
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="max-w-[960px]">
      <PageHeader title="Settings" description="Organization-wide preferences for Encop" />

      {error && (
        <Banner
          tone="warn"
          title="Saved settings couldn't be loaded"
          className="mb-4"
          action={
            <Button size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          }
        >
          {error.message} Times are shown in {timezone} for now.
        </Banner>
      )}

      <div className="flex flex-col gap-6">
        {SECTIONS.map(({ id, Component }) => (
          <Component key={id} />
        ))}
      </div>
    </div>
  );
}
