import { describe, expect, it } from 'vitest';
import { parseSlashCommand, SLASH_COMMANDS } from '@/lib/slash-commands';

describe('parseSlashCommand', () => {
  it('Given 完整命令行 When 解析 Then 识别为已知命令', () => {
    for (const c of SLASH_COMMANDS) {
      expect(parseSlashCommand(c.hint)).toEqual({ kind: 'command', name: c.name });
    }
    expect(parseSlashCommand('  /compact  ')).toEqual({ kind: 'command', name: 'compact' });
    expect(parseSlashCommand('/New')).toEqual({ kind: 'command', name: 'new' });
  });

  it('Given 未知斜杠命令 When 解析 Then 标记 unknown', () => {
    expect(parseSlashCommand('/foo')).toEqual({ kind: 'unknown', name: 'foo' });
    expect(parseSlashCommand('/login')).toEqual({ kind: 'unknown', name: 'login' });
  });

  it('Given 普通文本 When 解析 Then none(不拦截)', () => {
    expect(parseSlashCommand('你好')).toEqual({ kind: 'none' });
    expect(parseSlashCommand('/路径 说明')).toEqual({ kind: 'none' });
    expect(parseSlashCommand('写一段 /new 的说明')).toEqual({ kind: 'none' });
    expect(parseSlashCommand('')).toEqual({ kind: 'none' });
    expect(parseSlashCommand('/')).toEqual({ kind: 'none' });
  });
});

// /review 复盘命令(任务 6.10):weekly 是可选第二 token,arg 缺省 = daily 语义。
describe('parseSlashCommand /review', () => {
  it('Given /review When 解析 Then 识别为命令,daily 语义(arg 缺省)', () => {
    expect(parseSlashCommand('/review')).toEqual({ kind: 'command', name: 'review' });
  });

  it('Given /review weekly When 解析 Then 识别为命令,arg=weekly', () => {
    expect(parseSlashCommand('/review weekly')).toEqual({
      kind: 'command',
      name: 'review',
      arg: 'weekly',
    });
    expect(parseSlashCommand('  /review   weekly  ')).toEqual({
      kind: 'command',
      name: 'review',
      arg: 'weekly',
    });
  });

  it('Given /review foo When 解析 Then command 但 arg 非法(由 composer 拒绝)', () => {
    expect(parseSlashCommand('/review foo')).toEqual({
      kind: 'command',
      name: 'review',
      arg: 'foo',
    });
  });

  it('Given /review daily When 解析 Then command 但 arg 非法(仅 weekly 是合法第二 token)', () => {
    expect(parseSlashCommand('/review daily')).toEqual({
      kind: 'command',
      name: 'review',
      arg: 'daily',
    });
  });

  it('Given 存量命令带第二 token When 解析 Then 不拦截(原行为不回归)', () => {
    expect(parseSlashCommand('/compact now')).toEqual({ kind: 'none' });
    expect(parseSlashCommand('/new 今天')).toEqual({ kind: 'none' });
    expect(parseSlashCommand('/review weekly extra')).toEqual({ kind: 'none' });
  });
});
