import { PageSheet } from "../ui/PageSheet";
import { TodosPane } from "./TodosPane";

/**
 * A project's to-do list on its own, in iOS's page sheet: from the Mac sheet's "Your to-dos" and a reminder's tap. In a chat the
 * same list is a panel of its Changes sheet (or, on a tablet, of the pane beside it).
 */
export function TodosSheet({ project, projectName, onClose }: { project?: string | null; projectName?: string | null; onClose: () => void }) {
  return (
    <PageSheet onClose={onClose}>
      <TodosPane project={project} projectName={projectName} inSheet hideLabel="Done" onHide={onClose} />
    </PageSheet>
  );
}
