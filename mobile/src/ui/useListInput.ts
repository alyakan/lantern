import { useState } from "react";
import { continueList } from "../view/listInput";

/**
 * What a multi-line TextInput needs to continue a typed list (see continueList): its `onChangeText` and the `selection`
 * that puts the caret after the new marker, which is let go of again as soon as the input has moved there.
 */
export function useListInput(text: string, setText: (text: string) => void) {
  const [forced, setForced] = useState<{ start: number; end: number } | undefined>(undefined);
  return {
    onChangeText: (next: string) => {
      const edit = continueList(text, next);
      if (!edit) return setText(next);
      setText(edit.text);
      setForced({ start: edit.caret, end: edit.caret });
    },
    selection: forced,
    onSelectionChange: () => {
      if (forced) setForced(undefined);
    },
  };
}
