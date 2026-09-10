import type { KeyboardEvent } from "react";

/** Keep keyboard traversal within the active native modal, including edge wraps. */
export function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], summary, [tabindex]",
    ),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.getClientRects().length > 0,
  );
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const index = controls.indexOf(document.activeElement as HTMLElement);
  if (
    index < 0 ||
    (event.shiftKey && index === 0) ||
    (!event.shiftKey && index === controls.length - 1)
  ) {
    event.preventDefault();
    controls[event.shiftKey ? controls.length - 1 : 0].focus();
  }
}
