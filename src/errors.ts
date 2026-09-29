export type ErrorCode =
  | 'PARSE'
  | 'PATH_SYNTAX'
  | 'NOT_FOUND'
  | 'ALIAS'
  | 'ANCHOR'
  | 'EXISTS'
  | 'TYPE'
  | 'VALUE'
  | 'UNSUPPORTED'
  | 'VERIFY';

/** Thrown for every refused edit. The document text is never changed when this is thrown. */
export class YamlEditError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'YamlEditError';
    this.code = code;
  }
}
