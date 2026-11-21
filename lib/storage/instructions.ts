/** Instructions shared by the S3 prepare-upload tools. */
export const S3_UPLOAD_INSTRUCTIONS =
  "Send the raw file with one PUT to upload.url and every header in upload.headers exactly as returned " +
  "(curl: --upload-file path and one -H 'name: value' per header). The body must be exactly fileSize bytes. Success is HTTP 200."
