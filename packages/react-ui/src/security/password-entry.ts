import { useRef, useState, type ChangeEvent, type RefObject } from "react";

type Draft = { value: string; visible: boolean };

/** Clears registered password inputs even when a field is currently revealed. */
export function clearMountedPasswordFields(): void {
  document.querySelectorAll<HTMLInputElement>("input[data-password-entry]")
    .forEach((input) => { input.value = ""; });
}

/** Owns the drafts and presentation state of one password-entry form. */
export function usePasswordEntry<Field extends string>(fields: readonly Field[]) {
  const [drafts, setDrafts] = useState<Record<Field, Draft>>(() => {
    return Object.fromEntries(fields.map((field) =>
      [field, { value: "", visible: false }])) as Record<Field, Draft>;
  });
  const inputs = useRef(new Map<Field, HTMLInputElement>());

  function field(name: Field, forwardedRef?: RefObject<HTMLInputElement | null>,
    onValueChange?: (value: string) => void) {
    return {
      type: drafts[name].visible ? "text" as const : "password" as const,
      value: drafts[name].value,
      "data-password-entry": name,
      ref: (element: HTMLInputElement | null) => {
        if (element) inputs.current.set(name, element);
        else inputs.current.delete(name);
        if (forwardedRef) forwardedRef.current = element;
      },
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setDrafts((current) => ({ ...current,
          [name]: { ...current[name], value } }));
        onValueChange?.(value);
      },
    };
  }

  function toggle(...names: Field[]): void {
    const focused = document.activeElement;
    setDrafts((current) => {
      const next = { ...current };
      for (const name of names) next[name] = { ...next[name], visible: !next[name].visible };
      return next;
    });
    requestAnimationFrame(() => {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    });
  }

  function reset(...names: Field[]): void {
    const selected = names.length ? names : fields;
    for (const name of selected) {
      const input = inputs.current.get(name);
      if (input) input.value = "";
    }
    setDrafts((current) => {
      const next = { ...current };
      for (const name of selected) next[name] = { value: "", visible: false };
      return next;
    });
  }

  function replace(name: Field, candidate: string, confirmation?: Field): void {
    setDrafts((current) => ({ ...current,
      [name]: { ...current[name], value: candidate },
      ...(confirmation ? { [confirmation]: { ...current[confirmation], value: candidate } } : {}),
    }));
  }

  return { field, value: (name: Field) => drafts[name].value,
    visible: (name: Field) => drafts[name].visible, toggle, reset, replace };
}
