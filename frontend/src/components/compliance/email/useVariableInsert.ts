import { useCallback, useRef } from "react";

type Field = "subject" | "body";

/**
 * Lets one "Insert variable" menu serve two fields: it remembers the caret of whichever of the subject input
 * and the message textarea was used last, inserts the token there and puts the caret after it.
 */
export function useVariableInsert(subject: string, setSubject: (v: string) => void, body: string, setBody: (v: string) => void) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const last = useRef<{ field: Field; start: number; end: number }>({ field: "body", start: 0, end: 0 });

  const remember = useCallback(
    (field: Field) => (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      last.current = { field, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
    },
    []
  );

  const fieldProps = (field: Field) => ({ onSelect: remember(field), onBlur: remember(field), onKeyUp: remember(field), onClick: remember(field) });

  const insert = (token: string) => {
    const { field, start, end } = last.current;
    const text = field === "subject" ? subject : body;
    const s = Math.min(start, text.length);
    const e = Math.min(end, text.length);
    const next = text.slice(0, s) + token + text.slice(e);
    const pos = s + token.length;
    last.current = { field, start: pos, end: pos };
    if (field === "subject") setSubject(next);
    else setBody(next);
  };

  /** Put the focus (and caret) back where the token went, once the menu has closed. */
  const refocus = () =>
    window.setTimeout(() => {
      const { field, start } = last.current;
      const el = field === "subject" ? subjectRef.current : bodyRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(start, start);
      }
    }, 0);

  return { subjectRef, bodyRef, fieldProps, insert, refocus };
}
