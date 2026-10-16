/** One quiet line at the top of a chat that started with its project's notes; opened, it shows what the chat was told. */
export function NotesApplied({ text }: { text: string }) {
  return (
    <details className="notes-applied">
      <summary>Project notes applied</summary>
      <p className="notes-applied-text">{text}</p>
    </details>
  );
}
