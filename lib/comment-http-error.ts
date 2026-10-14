export class CommentHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = "CommentHttpError"
  }
}
