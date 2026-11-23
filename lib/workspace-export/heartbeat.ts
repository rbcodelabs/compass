/** Keep at most one renewal in flight. A failed renewal prevents acceptance of the provider response. */
export async function withImportHeartbeat<T>(renew: () => Promise<void>, io: () => Promise<T>, intervalMs = 60_000): Promise<T> {
  await renew()
  let stopped = false
  let failure: { cause: unknown } | undefined
  let pending: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout>
  function schedule() {
    timer = setTimeout(() => {
      pending = renew().then(() => {
        if (!stopped) schedule()
      }, cause => { failure = { cause } })
    }, intervalMs)
  }
  schedule()
  try {
    const value = await io()
    stopped = true
    await pending
    if (failure) throw failure.cause
    return value
  } finally {
    stopped = true
    clearTimeout(timer!)
    await pending
  }
}
