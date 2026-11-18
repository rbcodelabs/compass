/** Tool-result wording for an S3 presigned-POST direct upload (shared by the three prepare_* tools). */
export const S3_UPLOAD_INSTRUCTIONS =
  "Upload with ONE multipart/form-data POST to upload.url: send every entry of upload.fields exactly as returned, in order, then the file as the LAST field named \"file\" " +
  "(curl: one -F 'name=value' per field, then -F 'file=@path'). The file must be exactly fileSize bytes and fileType; success is HTTP 204. Do not add other fields."
