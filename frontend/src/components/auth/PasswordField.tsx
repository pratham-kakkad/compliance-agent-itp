import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { TextInput } from "../ui";

/** A password input with a show / hide toggle. */
export function PasswordField({
  id,
  value,
  onChange,
  autoComplete = "current-password",
  invalid,
  autoFocus,
  disabled,
  placeholder,
  describedBy,
  size = "lg",
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: "current-password" | "new-password";
  invalid?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  describedBy?: string;
  size?: "md" | "lg";
}) {
  const [shown, setShown] = useState(false);
  return (
    <TextInput
      id={id}
      type={shown ? "text" : "password"}
      size={size}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      disabled={disabled}
      invalid={invalid}
      placeholder={placeholder}
      aria-describedby={describedBy}
      spellCheck={false}
      trailingVisual={
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          className="flex h-6 w-6 items-center justify-center rounded text-ink3 hover:text-ink hover:bg-panel2"
        >
          {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      }
    />
  );
}

export const MIN_LENGTH = 10;

/** Live checklist under a "new password" field. */
export function PasswordHint({ value, id }: { value: string; id?: string }) {
  const ok = value.length >= MIN_LENGTH;
  return (
    <p id={id} className={`text-xs ${ok ? "text-good" : "text-ink2"}`}>
      {ok ? "Long enough." : `At least ${MIN_LENGTH} characters${value ? ` (${value.length} so far)` : ""}. A short phrase of a few words works well.`}
    </p>
  );
}
