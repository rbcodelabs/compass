import type { ComboboxItemData } from "@/components/ui/combobox";

export type KeyResultOption = { id: string; title: string; objectiveTitle: string };

/** The "no key result" choice every KR picker offers first. */
export const NO_KEY_RESULT = "__none__";

/**
 * Combobox items for picking an opportunity's driving Key Result: a "None"
 * entry, then each KR prefixed by its objective. Shared by the opportunity
 * panel header, the full-page overview and the "New opportunity" composer so
 * the three pickers list and search KRs identically.
 */
export function keyResultComboboxItems(keyResults: KeyResultOption[]): ComboboxItemData[] {
  return [
    { value: NO_KEY_RESULT, label: "— None —" },
    ...keyResults.map((kr) => ({
      value: kr.id,
      label: kr.title,
      render: (
        <>
          <span className="text-muted-foreground text-xs mr-1">{kr.objectiveTitle} /</span>
          {kr.title}
        </>
      ),
    })),
  ];
}
