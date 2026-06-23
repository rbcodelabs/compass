import { redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { ManageFieldsPanel } from "@/components/custom-fields/manage-fields-panel";
import type { CustomFieldDefinitionData, CustomFieldObjectType, CustomFieldType } from "@/lib/types";

export const metadata = { title: "Workspace Settings" };

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function SettingsPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, name: true },
  });

  if (!workspace) redirect("/dashboard");

  const rawFields = await prisma.customFieldDefinition.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ objectType: "asc" }, { order: "asc" }],
  });

  const fields: CustomFieldDefinitionData[] = rawFields.map((f) => ({
    id: f.id,
    name: f.name,
    fieldType: f.fieldType as CustomFieldType,
    objectType: f.objectType as CustomFieldObjectType,
    options: f.options as CustomFieldDefinitionData["options"],
    required: f.required,
    order: f.order,
  }));

  return (
    <main className="flex flex-col flex-1 p-6 gap-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">{workspace.name}</p>
      </div>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">Custom Fields</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Add fields to any object type. Click any field value on a record to edit it.
          </p>
        </div>

        <ManageFieldsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialFields={fields}
        />
      </section>
    </main>
  );
}
