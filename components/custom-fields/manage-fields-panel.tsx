"use client";

import { useState, useTransition, useRef } from "react";
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
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  CustomFieldType,
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
};

const OBJECT_TYPES = Object.keys(OBJECT_TYPE_LABELS) as CustomFieldObjectType[];

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialFields: CustomFieldDefinitionData[];
}

function AddFieldForm({
  objectType,
  orgSlug,
  workspaceSlug,
  onAdded,
}: {
  objectType: CustomFieldObjectType;
  orgSlug: string;
  workspaceSlug: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fieldType, setFieldType] = useState<CustomFieldType>("TEXT");
  const [selectOptions, setSelectOptions] = useState("");
  const [isPending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = nameRef.current?.value.trim() ?? "";
    if (!name) return;

    const options =
      fieldType === "SELECT" || fieldType === "MULTI_SELECT"
        ? selectOptions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => ({ label: s, value: s.toLowerCase().replace(/\s+/g, "_") }))
        : undefined;

    startTransition(async () => {
      await createFieldDefinition(orgSlug, workspaceSlug, {
        objectType,
        name,
        fieldType,
        options,
      });
      setOpen(false);
      setFieldType("TEXT");
      setSelectOptions("");
      onAdded();
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

      {(fieldType === "SELECT" || fieldType === "MULTI_SELECT") && (
        <div className="flex flex-col gap-1.5">
          <Label>Options (comma-separated)</Label>
          <Input
            placeholder="e.g. Low, Medium, High"
            value={selectOptions}
            onChange={(e) => setSelectOptions(e.target.value)}
            disabled={isPending}
          />
        </div>
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
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ManageFieldsPanel({ orgSlug, workspaceSlug, initialFields }: Props) {
  const [fields, setFields] = useState(initialFields);
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
      setFields((prev) => prev.filter((f) => f.id !== fieldId));
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
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">{field.name}</span>
                      <span className="text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground">
                        {FIELD_TYPE_LABELS[field.fieldType]}
                      </span>
                      {field.required && (
                        <span className="text-xs text-red-500">required</span>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(field.id)}
                      disabled={isPending}
                      className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                      aria-label={`Delete ${field.name}`}
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <AddFieldForm
              objectType={ot}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              onAdded={() => {}}
            />
          </div>
        </section>
      ))}
    </div>
  );
}
