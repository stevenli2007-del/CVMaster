import { redirect } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { getWorkspaceData } from "@/lib/workspace-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const workspace = await getWorkspaceData();
  if (!workspace) redirect("/login");
  return <Workspace initialWorkspace={workspace} />;
}
