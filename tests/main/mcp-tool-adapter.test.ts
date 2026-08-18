import { describe, expect, it } from 'vitest';
import { mcpToolName, mcpToolToSchema } from '../../src/main/mcp/tool-adapter';

/** TSchema 是 nominal 类型，测试经轻量 cast 读 TypeBox 的 type 判别符。 */
const typeOf = (s: unknown): string | undefined => (s as { type?: string }).type;

// plan S3: JSON Schema(子集) → TypeBox + 工具名编码。

describe('mcp tool-adapter', () => {
  it('mcpToolName 编码为 mcp_<server>_<tool>', () => {
    expect(mcpToolName('svc', 'search')).toBe('mcp_svc_search');
  });

  it('string schema → Type.String；enum → Union(Literal)', () => {
    const s = mcpToolToSchema({ type: 'string' });
    expect(typeOf(s)).toBe('string');
  });

  it('object schema → Type.Object（properties + required）', () => {
    const s = mcpToolToSchema({
      type: 'object',
      properties: { q: { type: 'string' }, n: { type: 'number' } },
      required: ['q'],
    });
    expect(typeOf(s)).toBe('object');
  });

  it('array schema → Type.Array', () => {
    const s = mcpToolToSchema({ type: 'array', items: { type: 'string' } });
    expect(typeOf(s)).toBe('array');
  });

  it('非法/空 schema → Type.Any（宽松不抛；Any 无 type 字段）', () => {
    expect(typeOf(mcpToolToSchema(undefined))).toBeUndefined();
    expect(typeOf(mcpToolToSchema({ type: 'nonsense' }))).toBeUndefined();
  });
});
