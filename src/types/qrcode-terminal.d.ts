declare module "qrcode-terminal" {
  const value: {
    generate(input: string, options?: { small?: boolean }, callback?: (qrcode: string) => void): void;
  };

  export default value;
}
