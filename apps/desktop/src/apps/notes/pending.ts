import { create } from "zustand";

/**
 * A note the vault view should open next. NotesView keeps its active note in
 * component state, so outside navigators (the ⌘K palette) park the name here
 * and the view consumes and clears it.
 */
export const useNotesPending = create<{
  name: string | null;
  request: (name: string) => void;
  clear: () => void;
}>((set) => ({
  name: null,
  request: (name) => set({ name }),
  clear: () => set({ name: null }),
}));
