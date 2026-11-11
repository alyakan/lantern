import dagre from "@dagrejs/dagre";
import { layoutWith, type ArchSpec } from "../../../shared/archGraph";
export * from "../../../shared/archGraph";

const engine = { createGraph: () => new dagre.graphlib.Graph({ multigraph: true }), layout: dagre.layout };

/** The shared geometry, using the layout engine bundled with this app. */
export const layoutArchitecture = (spec: ArchSpec, direction: "LR" | "TB" = "LR", rowMax?: number) => layoutWith(engine, spec, direction, rowMax);
