"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createFieldDefinition,
  deleteFieldDefinition,
  updateFieldDefinition,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { OptionListEditor } from "@/components/custom-fields/option-list-editor";
import { hasOptionListIssues } from "@/lib/option-list";
import { supportsSharedOptionSet, type SelectOptionInput } from "@/lib/shared-field-options";
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  CustomFieldType,
  SharedFieldOptionSetData,
} from "@/lib/types";

const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  DATE: "Date",
  SELECT: "Select",
  MULTI_SELECT: "Multi-select",
  URL: "URL",
  BOOLEAN: "Yes / No",
};

const OBJECT_TYPE_LABELS: Record<CustomFieldObjectType, string> = {
  OPPORTUNITY: "Opportunity",
  SOLUTION: "Solution",
  EXPERIMENT: "Experiment",
  OBJECTIVE: "Objective",
  KEY_RESULT: "Key Result",
  ROADMAP_ITEM: "Roadmap Item",
  TASK: "Task",
};

const OBJECT_TYPES = Object.keys(OBJECT_TYPE_LABELS) as CustomFieldObjectType[];

/** Sentinel for "keep this field's own local options" in the shared-set picker. */
const LOCAL_OPTIONS = "__local__";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialFields: CustomFieldDefinitionData[];
  sharedOptionSets: SharedFieldOptionSetData[];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function AddFieldForm({
  objectType,
  orgSlug,
  workspaceSlug,
  sharedOptionSets,
  onAdded,
}: {
  objectType: CustomFieldObjectType;
  orgSlug: string;
  workspaceSlug: string;
  sharedOptionSets: SharedFieldOptionSetData[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fieldType, setFieldType] = useState<CustomFieldType>("TEXT");
  const [selectOptions, setSelectOptions] = useState<SelectOptionInput[]>([]);
  const [optionSource, setOptionSource] = useState<string>(LOCAL_OPTIONS);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  const isPicklist = supportsSharedOptionSet(fieldType);
  const usesSharedSet = isPicklist && optionSource !== LOCAL_OPTIONS;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = nameRef.current?.value.trim() ?? "";
    if (!name) return;
    const usesLocalOptions = isPicklist && !usesSharedSet;
    if (usesLocalOptions && hasOptionListIssues(selectOptions)) {
      setError("Fix the highlighted options before adding the field.");
      return;
    }
    setError(null);

    startTransition(async () => {
      try {
        await createFieldDefinition(orgSlug, workspaceSlug, {
          objectType,
          name,
          fieldType,
          options: usesLocalOptions ? selectOptions : undefined,
          sharedOptionSetId: usesSharedSet ? optionSource : null,
        });
        setOpen(false);
        setFieldType("TEXT");
        setSelectOptions([]);
        setOptionSource(LOCAL_OPTIONS);
        onAdded();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 w-full rounded-lg border border-dashed border-border/60 py-2 px-3 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add field
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-medium">New field for {OBJECT_TYPE_LABELS[objectType]}</p>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`field-name-${objectType}`}>Name</Label>
          <Input
            id={`field-name-${objectType}`}
            ref={nameRef}
            placeholder="e.g. Priority, Owner"
            autoFocus
            required
            disabled={isPending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`field-type-${objectType}`}>Type</Label>
          <Select
            value={fieldType}
            onValueChange={(v) => setFieldType(v as CustomFieldType)}
            disabled={isPending}
          >
            <SelectTrigger id={`field-type-${objectType}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FIELD_TYPE_LABELS) as CustomFieldType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isPicklist && sharedOptionSets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`field-option-source-${objectType}`}>Options come from</Label>
          <Select
            value={optionSource}
            onValueChange={(value) => setOptionSource(value ?? LOCAL_OPTIONS)}
            disabled={isPending}
          >
            <SelectTrigger id={`field-option-source-${objectType}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={LOCAL_OPTIONS}>This field only</SelectItem>
              {sharedOptionSets.map((set) => (
                <SelectItem key={set.id} value={set.id}>
                  Shared: {set.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {isPicklist && !usesSharedSet && (
        <OptionListEditor
          label="Options"
          value={selectOptions}
          onChange={setSelectOptions}
          disabled={isPending}
        />
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding..." : "Add Field"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function OptionSourcePicker({
  orgSlug,
  workspaceSlug,
  field,
  sharedOptionSets,
}: {
  orgSlug: string;
  workspaceSlug: string;
  field: CustomFieldDefinitionData;
  sharedOptionSets: SharedFieldOptionSetData[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function change(next: string | null) {
    setError(null);
    startTransition(async () => {
      try {
        await updateFieldDefinition(orgSlug, workspaceSlug, field.id, {
          // Detaching copies the set's current options down — the server action
          // owns that so no picklist is ever emptied by switching source here.
          sharedOptionSetId: !next || next === LOCAL_OPTIONS ? null : next,
        });
        router.refresh();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        value={field.sharedOptionSetId ?? LOCAL_OPTIONS}
        onValueChange={change}
        disabled={isPending}
      >
        <SelectTrigger
          size="sm"
          className="w-[190px]"
          aria-label={`Option source for ${field.name}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LOCAL_OPTIONS}>This field only</SelectItem>
          {sharedOptionSets.map((set) => (
            <SelectItem key={set.id} value={set.id}>
              Shared: {set.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function ManageFieldsPanel({
  orgSlug,
  workspaceSlug,
  initialFields,
  sharedOptionSets,
}: Props) {
  const router = useRouter();
  // Render the server's list (refreshed via router.refresh() after an add) and
  // only overlay optimistic deletes — copying initialFields into state froze
  // the list at mount, so a newly added field never appeared until a reload.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
  const fields = initialFields.filter((f) => !deletedIds.has(f.id));
  const [isPending, startTransition] = useTransition();

  const byObjectType = OBJECT_TYPES.reduce(
    (acc, ot) => {
      acc[ot] = fields.filter((f) => f.objectType === ot);
      return acc;
    },
    {} as Record<CustomFieldObjectType, CustomFieldDefinitionData[]>
  );

  function handleDelete(fieldId: string) {
    startTransition(async () => {
      await deleteFieldDefinition(orgSlug, workspaceSlug, fieldId);
      setDeletedIds((prev) => new Set(prev).add(fieldId));
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-8">
      {OBJECT_TYPES.map((ot) => (
        <section key={ot}>
          <h3 className="text-sm font-semibold mb-3">{OBJECT_TYPE_LABELS[ot]}</h3>

          <div className="flex flex-col gap-2">
            {byObjectType[ot].length === 0 ? (
              <p className="text-xs text-muted-foreground">No custom fields defined.</p>
            ) : (
              <div className="rounded-xl border border-border overflow-hidden">
                {byObjectType[ot].map((field, i) => (
                  <div
                    key={field.id}
                    className={`flex items-center justify-between gap-3 px-4 py-2.5 ${
                      i > 0 ? "border-t border-border" : ""
                    }`}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                      <span className="text-sm font-medium">{field.name}</span>
                      <span className="text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground">
                        {FIELD_TYPE_LABELS[field.fieldType]}
                      </span>
                      {field.required && (
                        <span className="text-xs text-destructive">required</span>
                      )}
                      {field.sharedOptionSetName && (
                        <span className="text-xs text-muted-foreground">
                          shared list: {field.sharedOptionSetName}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {supportsSharedOptionSet(field.fieldType) && sharedOptionSets.length > 0 && (
                        <OptionSourcePicker
                          orgSlug={orgSlug}
                          workspaceSlug={workspaceSlug}
                          field={field}
                          sharedOptionSets={sharedOptionSets}
                        />
                      )}
                      <button
                        onClick={() => handleDelete(field.id)}
                        disabled={isPending}
                        className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        aria-label={`Delete ${field.name}`}
                      >
                        <TrashIcon className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <AddFieldForm
              objectType={ot}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              sharedOptionSets={sharedOptionSets}
              onAdded={() => router.refresh()}
            />
          </div>
        </section>
      ))}
    </div>
  );
}
