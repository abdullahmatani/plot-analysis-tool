/**
 * DXF group code value types (AutoCAD DXF reference, "Group Code Value Types"). The same table
 * drives ASCII value conversion and binary DXF value decoding.
 */
export const VT = {
  STRING: 0,
  DOUBLE: 1,
  INT16: 2,
  INT32: 3,
  INT64: 4,
  BOOL: 5,
  /** Binary chunk: hex string in ASCII DXF, length-prefixed bytes in binary DXF. */
  BINARY: 6,
} as const;

export type ValueType = (typeof VT)[keyof typeof VT];

export const MAX_GROUP_CODE = 1071;

function buildTable(): Uint8Array {
  const t = new Uint8Array(MAX_GROUP_CODE + 1); // default STRING (0)
  const set = (from: number, to: number, v: ValueType) => {
    for (let c = from; c <= to; c++) t[c] = v;
  };
  set(10, 59, VT.DOUBLE);
  set(60, 79, VT.INT16);
  set(90, 99, VT.INT32);
  set(110, 149, VT.DOUBLE);
  set(160, 169, VT.INT64);
  set(170, 179, VT.INT16);
  set(210, 239, VT.DOUBLE);
  set(270, 289, VT.INT16);
  set(290, 299, VT.BOOL);
  set(310, 319, VT.BINARY);
  set(370, 389, VT.INT16);
  set(400, 409, VT.INT16);
  set(420, 429, VT.INT32);
  set(440, 459, VT.INT32);
  set(460, 469, VT.DOUBLE);
  set(1004, 1004, VT.BINARY);
  set(1010, 1059, VT.DOUBLE);
  set(1060, 1070, VT.INT16);
  set(1071, 1071, VT.INT32);
  return t;
}

/** Value type per group code (index = code, 0…1071). Codes outside the table are strings. */
export const VALUE_TYPE: Uint8Array = buildTable();

export function valueType(code: number): ValueType {
  return (code >= 0 && code <= MAX_GROUP_CODE ? VALUE_TYPE[code] : VT.STRING) as ValueType;
}

export function isNumericCode(code: number): boolean {
  const t = valueType(code);
  return t !== VT.STRING && t !== VT.BINARY;
}
