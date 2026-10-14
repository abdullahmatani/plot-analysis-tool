/** Thrown when the input is not a DXF file or is structurally broken beyond recovery. */
export class DxfParseError extends Error {
  /** 1-based line number (ASCII DXF) where the problem was detected, when known. */
  line?: number;
  /** Byte offset (binary DXF) where the problem was detected, when known. */
  offset?: number;

  constructor(message: string, where?: { line?: number; offset?: number }) {
    const suffix =
      where?.line !== undefined
        ? ` (line ${where.line})`
        : where?.offset !== undefined
          ? ` (byte ${where.offset})`
          : '';
    super(message + suffix);
    this.name = 'DxfParseError';
    this.line = where?.line;
    this.offset = where?.offset;
  }
}

/** Thrown when parsing is cancelled through `opts.signal`. */
export class DxfAbortError extends Error {
  constructor(message = 'DXF import cancelled') {
    super(message);
    this.name = 'DxfAbortError';
  }
}

/** Internal: an individual entity is invalid; the entity is skipped and reported, parsing continues. */
export class InvalidEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntityError';
  }
}
