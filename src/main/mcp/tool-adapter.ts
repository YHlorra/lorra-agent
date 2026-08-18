import { type TSchema, Type } from 'typebox';

/**
 * MCP inputSchema（JSON Schema）→ TypeBox 转换（plan S3）。
 * pi 的 registerTool 要求 TypeBox TSchema；只覆盖 MCP 工具常用 JSON Schema 子集：
 * type(必选)/properties/required/enum。非法/不支持 → 退化为 Type.Any（宽松参数）。
 */

function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  const t = schema.type;
  if (t === 'string') {
    return Array.isArray(schema.enum)
      ? Type.Union(schema.enum.map((v) => Type.Literal(String(v))))
      : Type.String();
  }
  if (t === 'number' || t === 'integer') return Type.Number();
  if (t === 'boolean') return Type.Boolean();
  if (t === 'array') {
    const items = schema.items;
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      return Type.Array(jsonSchemaToTypeBox(items as Record<string, unknown>));
    }
    return Type.Array(Type.Any());
  }
  if (t === 'object') {
    const props: Record<string, TSchema> = {};
    const required: string[] = [];
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [k, v] of Object.entries(properties as Record<string, unknown>)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          props[k] = jsonSchemaToTypeBox(v as Record<string, unknown>);
        }
      }
    }
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (typeof r === 'string') required.push(r);
    }
    if (Object.keys(props).length === 0) return Type.Record(Type.String(), Type.Any());
    return Type.Object(props, {
      additionalProperties: true,
      ...(required.length > 0 ? { required } : {}),
    });
  }
  return Type.Any();
}

/** 把 MCP 工具 inputSchema 转成 TypeBox 参数 schema（宽松：缺/非法 schema → Type.Any）。 */
export function mcpToolToSchema(inputSchema: Record<string, unknown> | undefined): TSchema {
  if (!inputSchema) return Type.Any();
  try {
    return jsonSchemaToTypeBox(inputSchema);
  } catch {
    return Type.Any();
  }
}

/** 工具名编码：mcp_<serverId>_<toolName>（防与内建/技能工具冲突）。 */
export function mcpToolName(serverId: string, toolName: string): string {
  return 'mcp_' + serverId + '_' + toolName;
}
