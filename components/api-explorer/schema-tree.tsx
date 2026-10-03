import { asObject, resolveSchema, schemaSummary } from "@/lib/rest-explorer";

export function SchemaTree({
  value,
  document,
  name = "Schema",
  depth = 0,
  refs = [],
}: {
  value: unknown;
  document: unknown;
  name?: string;
  depth?: number;
  refs?: string[];
}) {
  const original = asObject(value),
    ref = typeof original.$ref === "string" ? original.$ref : undefined;
  if (depth > 8 || (ref && refs.includes(ref)))
    return (
      <p className="text-text-subtle text-xs py-2">
        {name}: recursive reference {ref ?? "(depth limit)"}
      </p>
    );
  const schema = resolveSchema(value, document),
    nextRefs = ref ? [...refs, ref] : refs;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return (
    <div className="border-l border-border-default pl-3 py-2 min-w-0">
      <p className="break-words">
        <code>{name}</code>{" "}
        <span className="text-text-secondary text-xs">
          {schemaSummary(value === false || value === true ? value : schema)}
        </span>
      </p>
      {typeof schema.description === "string" && (
        <p className="text-xs text-text-subtle break-words">
          {schema.description}
        </p>
      )}
      {Object.entries(asObject(schema.properties)).map(([key, property]) => (
        <SchemaTree
          key={key}
          name={`${key}${required.includes(key) ? " *" : ""}`}
          value={property}
          document={document}
          depth={depth + 1}
          refs={nextRefs}
        />
      ))}
      {schema.items !== undefined && (
        <SchemaTree
          name="items"
          value={schema.items}
          document={document}
          depth={depth + 1}
          refs={nextRefs}
        />
      )}
      {["anyOf", "oneOf", "allOf"].map(
        (kind) =>
          Array.isArray(schema[kind]) &&
          schema[kind].map((member, index) => (
            <SchemaTree
              key={`${kind}:${index}`}
              name={`${kind} ${index + 1}`}
              value={member}
              document={document}
              depth={depth + 1}
              refs={nextRefs}
            />
          )),
      )}
    </div>
  );
}
