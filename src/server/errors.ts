export class OtlpParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OtlpParseError";
  }
}

export class UnsupportedOtlpContentTypeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedOtlpContentTypeError";
  }
}
