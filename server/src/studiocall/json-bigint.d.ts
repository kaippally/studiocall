declare module 'json-bigint' {
  interface Options { storeAsString?: boolean; useNativeBigInt?: boolean; alwaysParseAsBig?: boolean; strict?: boolean }
  interface JSONBigInt { parse(text: string): any; stringify(value: any, replacer?: any, space?: any): string }
  export default function JSONBig(options?: Options): JSONBigInt;
}
