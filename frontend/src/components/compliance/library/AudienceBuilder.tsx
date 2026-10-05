import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Plus, Trash2, TriangleAlert, Users } from "lucide-react";
import { api } from "../../../lib/api";
import { useDebouncedValue } from "../../../lib/useDebouncedValue";
import {
  PARTICIPATION_LABEL,
  SELECTOR_LABEL,
  type AudiencePreview,
  type Lookup,
  type Meta,
  type Participation,
  type SelectorType,
} from "../../../lib/compliance";
import { Banner, Button, EmptyState, IconButton, SegmentedControl, Select, Skeleton } from "../../ui";
import { Field, ParticipationLabel, PersonCell, errText } from "../common";
import { Combobox, type ComboOption } from "./Combobox";
import { audiencePayload, newAudienceRule, stable, type AudDraft, type Issue } from "./formModel";
import { viaText } from "./describe";

export interface PreviewState {
  data: AudiencePreview | null;
  loading: boolean;
  error: string | null;
}

/** Live "who would this reach" for the rules as they stand (debounced; ignores unfinished rules). */
export function useAudiencePreview(rules: AudDraft[], enabled: boolean): PreviewState {
  const complete = useMemo(() => audiencePayload(rules.filter((r) => r.selector_type === "all" || r.selector_ref)), [rules]);
  const key = stable(complete);
  const debouncedKey = useDebouncedValue(key, 400);
  const [state, setState] = useState<PreviewState>({ data: null, loading: false, error: null });
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const body = JSON.parse(debouncedKey) as ReturnType<typeof audiencePayload>;
    if (body.length === 0) {
      seq.current++;
      setState({ data: null, loading: false, error: null });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .post<AudiencePreview>("/compliance/audience/preview", { audience: body })
      .then((d) => mine === seq.current && setState({ data: d, loading: false, error: null }))
      .catch((e) => mine === seq.current && setState((s) => ({ ...s, loading: false, error: errText(e) })));
  }, [debouncedKey, enabled]);

  // Typing is ahead of the last answer: say so instead of showing stale numbers as current.
  const pending = key !== debouncedKey;
  return { ...state, loading: state.loading || pending };
}

const SELECTOR_ORDER: SelectorType[] = ["team", "department", "person", "role", "subtree", "all"];

function optionsFor(type: SelectorType, lookup: Lookup | null): ComboOption[] {
  if (!lookup) return [];
  switch (type) {
    case "person":
    case "subtree":
      return lookup.users.map((u) => ({ value: u.email, label: u.name, hint: [u.title, u.department].filter(Boolean).join(" · ") || u.email }));
    case "team":
      return lookup.teams.map((t) => ({ value: t.id, label: t.name, hint: `${t.members} ${t.members === 1 ? "member" : "members"}` }));
    case "department":
      return lookup.departments.map((d) => ({ value: d.id, label: d.name }));
    case "role":
      return lookup.roles.map((r) => ({ value: r.key, label: r.name }));
    default:
      return [];
  }
}

const REF_LABEL: Record<SelectorType, string> = {
  person: "Person",
  team: "Team",
  department: "Department",
  role: "Role",
  subtree: "Manager",
  all: "",
};

export function peopleOptions(lookup: Lookup | null): ComboOption[] {
  return optionsFor("person", lookup);
}

function RuleRow({
  rule,
  lookup,
  selectors,
  participations,
  error,
  onChange,
  onRemove,
  disabled,
  index,
}: {
  rule: AudDraft;
  lookup: Lookup | null;
  selectors: SelectorType[];
  participations: Participation[];
  error?: string;
  onChange: (patch: Partial<AudDraft>) => void;
  onRemove: () => void;
  disabled?: boolean;
  index: number;
}) {
  const include = rule.effect === "include";
  const options = useMemo(() => optionsFor(rule.selector_type, lookup), [rule.selector_type, lookup]);
  return (
    <li
      className={clsx(
        "rounded-lg border p-3 flex flex-col gap-3 lg:flex-row lg:items-end",
        include ? "border-line bg-panel" : "border-line bg-panel2"
      )}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-ink2" id={`${rule.uid}-effect`}>Rule {index + 1}</span>
        <SegmentedControl
          aria-label={`Rule ${index + 1}: include or exclude`}
          size="sm"
          value={rule.effect}
          onChange={(v) => onChange({ effect: v })}
          options={[
            { value: "include", label: "Include" },
            { value: "exclude", label: "Exclude" },
          ]}
          className={disabled ? "pointer-events-none opacity-60" : ""}
        />
      </div>
      <Field label="Who" className="lg:w-56">
        {(id) => (
          <Select
            id={id}
            value={rule.selector_type}
            disabled={disabled}
            onChange={(e) => onChange({ selector_type: e.target.value as SelectorType, selector_ref: "" })}
            className="w-full"
          >
            {selectors.map((s) => (
              <option key={s} value={s}>
                {SELECTOR_LABEL[s]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {rule.selector_type !== "all" ? (
        <Field label={REF_LABEL[rule.selector_type]} error={error} className="min-w-0 lg:flex-1">
          {(id) => (
            <Combobox
              id={id}
              value={rule.selector_ref}
              onChange={(v) => onChange({ selector_ref: v })}
              options={options}
              placeholder={`Choose ${REF_LABEL[rule.selector_type].toLowerCase()}…`}
              emptyText={lookup ? "Nothing matches" : "The list couldn't be loaded"}
              invalid={Boolean(error)}
              disabled={disabled}
            />
          )}
        </Field>
      ) : (
        <p className="text-[13px] text-ink2 lg:flex-1 lg:pb-1.5">Everyone in the organization.</p>
      )}
      {include && (
        <Field label="Their part" className="lg:w-44">
          {(id) => (
            <Select
              id={id}
              value={rule.participation}
              disabled={disabled}
              onChange={(e) => onChange({ participation: e.target.value as Participation })}
              className="w-full"
            >
              {participations.map((p) => (
                <option key={p} value={p}>
                  {PARTICIPATION_LABEL[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <IconButton icon={Trash2} label={`Remove rule ${index + 1}`} onClick={onRemove} disabled={disabled} className="self-end lg:mb-0" />
    </li>
  );
}

export function AudienceBuilder({
  rules,
  onChange,
  lookup,
  lookupError,
  onRetryLookup,
  meta,
  dynamic,
  onDynamic,
  preview,
  issues,
  readOnly,
  showErrors,
}: {
  rules: AudDraft[];
  onChange: (rules: AudDraft[]) => void;
  lookup: Lookup | null;
  lookupError: string | null;
  onRetryLookup: () => void;
  meta: Meta;
  dynamic: boolean;
  onDynamic: (v: boolean) => void;
  preview: PreviewState;
  issues: Issue[];
  readOnly?: boolean;
  showErrors: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const selectors = SELECTOR_ORDER.filter((s) => meta.selector_types.includes(s));
  const participations = meta.participation;
  const fieldError = (uid: string) => (showErrors ? issues.find((i) => i.field === `aud-${uid}`)?.message : undefined);
  const patch = (uidv: string, p: Partial<AudDraft>) => onChange(rules.map((r) => (r.uid === uidv ? { ...r, ...p } : r)));
  const data = preview.data;
  const LIMIT = 100;
  const people = data ? (showAll ? data.people : data.people.slice(0, LIMIT)) : [];
  const noInclude = !rules.some((r) => r.effect === "include");
  const includeIssue = showErrors && noInclude ? issues.find((i) => i.field === "audience")?.message : undefined;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink2 leading-[19px]">
        Add rules to build the list of people. The strongest part wins when someone matches several rules (Must act beats Optional, which beats For
        information) and a rule that excludes always wins. People who <strong className="text-ink">must act</strong> count towards completion; people who are
        only <strong className="text-ink">informed</strong> just see it.
      </p>

      {lookupError && (
        <Banner tone="warn" title="The people lists couldn't be loaded" action={<Button size="sm" onClick={onRetryLookup}>Try again</Button>}>
          {lookupError}
        </Banner>
      )}

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong">
          <EmptyState
            compact
            icon={Users}
            title="Nobody is chosen yet"
            description="Start with a team, a department, or named people."
            action={
              !readOnly && (
                <Button leadingIcon={Plus} onClick={() => onChange([newAudienceRule()])}>
                  Add a rule
                </Button>
              )
            }
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5" aria-label="Audience rules">
          {rules.map((r, i) => (
            <RuleRow
              key={r.uid}
              rule={r}
              index={i}
              lookup={lookup}
              selectors={selectors}
              participations={participations}
              error={fieldError(r.uid)}
              onChange={(p) => patch(r.uid, p)}
              onRemove={() => onChange(rules.filter((x) => x.uid !== r.uid))}
              disabled={readOnly}
            />
          ))}
        </ul>
      )}

      {rules.length > 0 && !readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button leadingIcon={Plus} onClick={() => onChange([...rules, newAudienceRule()])}>
            Add a rule
          </Button>
          <Button variant="ghost" leadingIcon={Plus} onClick={() => onChange([...rules, { ...newAudienceRule(), effect: "exclude" }])}>
            Add an exclusion
          </Button>
        </div>
      )}
      {includeIssue && <p className="text-xs text-crit" role="alert">{includeIssue}</p>}

      <label className="flex items-start gap-2.5 text-sm cursor-pointer">
        <input type="checkbox" checked={dynamic} disabled={readOnly} onChange={(e) => onDynamic(e.target.checked)} className="mt-1 accent-[var(--accent)]" />
        <span>
          <span className="font-semibold text-ink">Keep the audience up to date automatically</span>
          <span className="block text-[13px] text-ink2">
            New joiners who match these rules are assigned, and people who no longer match are taken off, without anyone editing this.
          </span>
        </span>
      </label>

      <div className="rounded-lg border border-line bg-panel2" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-line">
          <h4 className="text-sm font-semibold text-ink">Preview audience</h4>
          {data && (
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink2">
              <span className="font-semibold text-ink tabular">{data.total}</span> {data.total === 1 ? "person" : "people"}
              {(Object.keys(data.by_participation) as Participation[]).map((p) => (
                <span key={p} className="inline-flex items-center gap-1 ml-1.5">
                  <ParticipationLabel participation={p} />
                  <span className="tabular">{data.by_participation[p]}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {data && data.outside_scope > 0 && (
          <Banner tone="warn" icon={TriangleAlert} className="m-3 mb-0" title="Some people are out of your reach">
            {data.outside_scope} {data.outside_scope === 1 ? "person is" : "people are"} outside the people you may assign to. You won't be able to publish until
            you remove them.
          </Banner>
        )}
        {preview.error && (
          <Banner tone="crit" className="m-3 mb-0" title="The preview couldn't be worked out">
            {preview.error}
          </Banner>
        )}

        <div className={clsx("transition-opacity", preview.loading && data && "opacity-60")}>
          {rules.length === 0 || (!data && !preview.loading && !preview.error) ? (
            <p className="px-4 py-5 text-[13px] text-ink2">Add a rule and the people it reaches will show here.</p>
          ) : !data && preview.loading ? (
            <div className="p-4 flex flex-col gap-2.5" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-4" style={{ width: `${70 - i * 12}%` }} />
              ))}
            </div>
          ) : data && data.total === 0 ? (
            <p className="px-4 py-5 text-[13px] text-ink2">These rules don't match anyone right now.</p>
          ) : data ? (
            <>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm border-collapse">
                  <caption className="sr-only">People in the audience</caption>
                  <thead className="sticky top-0 bg-panel2">
                    <tr className="text-left text-xs font-semibold text-ink2">
                      <th scope="col" className="px-4 h-8">Person</th>
                      <th scope="col" className="px-3 h-8 hidden sm:table-cell">Department</th>
                      <th scope="col" className="px-3 h-8">Part</th>
                      <th scope="col" className="px-3 pr-4 h-8 hidden md:table-cell">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.email} className="border-t border-line-soft">
                        <td className="pl-4 pr-3 py-2">
                          <PersonCell person={p} size={22} />
                          {!p.in_scope && <span className="text-xs text-warn">Outside your scope</span>}
                        </td>
                        <td className="px-3 py-2 text-ink2 hidden sm:table-cell">{p.department ?? "—"}</td>
                        <td className="px-3 py-2"><ParticipationLabel participation={p.participation} /></td>
                        <td className="px-3 pr-4 py-2 text-xs text-ink2 hidden md:table-cell">{p.via.map((v) => viaText(v, lookup)).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.people.length > LIMIT && (
                <div className="px-4 py-2.5 border-t border-line text-[13px] text-ink2 flex items-center justify-between gap-2">
                  <span>{showAll ? `Showing all ${data.people.length}` : `Showing the first ${LIMIT} of ${data.people.length}`}</span>
                  <Button size="sm" variant="ghost" onClick={() => setShowAll((s) => !s)}>
                    {showAll ? "Show fewer" : "Show everyone"}
                  </Button>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
