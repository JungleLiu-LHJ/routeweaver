declare module "@tencent-weixin/openclaw-weixin/dist/src/cdn/pic-decrypt.js" {
  export function downloadAndDecryptBuffer(
    encryptQueryParam: string,
    aesKeyBase64: string,
    cdnBaseUrl: string,
    label?: string,
    fullUrl?: string
  ): Promise<Buffer>;

  export function downloadPlainCdnBuffer(
    encryptQueryParam: string,
    cdnBaseUrl: string,
    label?: string,
    fullUrl?: string
  ): Promise<Buffer>;
}
