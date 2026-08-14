/**
 * 划线/笔记/对话 标注数据模型(renderer/main 共用)。
 * 存储于工作区 `.lorra/annotations.jsonl`(应用数据目录,与 `.pi` 同级)。
 */

/** 锚点:渲染时用于定位高亮位置(文本锚点取选区前/后各 50 字符消歧)。 */
export type AnnotationAnchor =
  | { type: 'text'; before: string; after: string } // md/code/pdf:选区文本前后文
  | { type: 'cfi'; cfi: string } // epub:epubjs CFI
  | { type: 'pdf'; page: number; before: string; after: string }; // pdf:页码 + 前后文

export interface Annotation {
  /** crypto.randomUUID,renderer 生成 */
  id: string;
  /** 工作区相对路径,正斜杠;主进程从 fileId 解析后回填,renderer 不传 */
  relPath: string;
  kind: 'md' | 'code' | 'epub' | 'pdf';
  /** 选中原文(截断 500 字符,超长加 …) */
  text: string;
  /** 笔记正文 */
  note?: string;
  anchor: AnnotationAnchor;
  /** ISO 8601 */
  createdAt: string;
}

/** IPC 传输用:relPath 由主进程回填。 */
export type AnnotationDraft = Omit<Annotation, 'relPath'>;
