const isAlreadyCheckedIn = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Number(data.code) !== 1) return false
  const message = String(data.message ?? '')
  if (/没有权限|automated check-in/i.test(message)) return false
  return /tomorrow|already checked in|check-?in repeats|observation logged|明天再来|已签到/i.test(message)
}

const browserHeaders = (cookie, method) => {
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-TW;q=0.6',
    'cache-control': 'no-cache',
    'cookie': cookie,
    'origin': 'https://glados.one',
    'pragma': 'no-cache',
    'priority': 'u=1, i',
    'referer': 'https://glados.one/console/checkin',
    'sec-ch-ua': '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  }
  if (method === 'POST') headers['content-type'] = 'application/json;charset=UTF-8'
  return headers
}

const requestJson = async (url, options, what, { allowAlreadyCheckedIn = false } = {}) => {
  let response
  try {
    response = await fetch(url, options)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${what} request failed: ${reason}`)
  }

  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${what} returned a non-JSON response (HTTP ${response.status})`)
  }

  const apiMessage = data && typeof data === 'object' && !Array.isArray(data) && data.message != null
    ? String(data.message)
    : ''

  if (!response.ok) {
    throw new Error(apiMessage
      ? `${what} failed (HTTP ${response.status}): ${apiMessage}`
      : `${what} failed (HTTP ${response.status})`)
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || data.code == null) {
    throw new Error(apiMessage
      ? `${what} returned a bad response: ${apiMessage}`
      : `${what} returned a bad response`)
  }

  if (allowAlreadyCheckedIn && isAlreadyCheckedIn(data)) return data

  if (Number(data.code) !== 0) {
    throw new Error(apiMessage || `${what} failed (code ${data.code})`)
  }

  return data
}

const glados = async () => {
  const notice = []
  if (!process.env.GLADOS || !String(process.env.GLADOS).trim()) {
    console.log('GLADOS is empty')
    return { notice: null, failed: true }
  }

  const cookies = String(process.env.GLADOS).split('\n')
  const redact = (text) => {
    let value = String(text)
    for (const secret of cookies) {
      if (secret) value = value.split(secret).join('[redacted]')
    }
    return value
  }

  let index = 0
  let failed = false
  for (const cookie of cookies) {
    if (!cookie) continue
    index += 1
    let message = ''
    let leftDays = 'unknown'
    try {
      const action = await requestJson('https://glados.one/api/user/checkin', {
        method: 'POST',
        headers: browserHeaders(cookie, 'POST'),
        body: '{"token":"glados.one"}',
      }, 'check-in', { allowAlreadyCheckedIn: true })
      const already = isAlreadyCheckedIn(action)
      message = action.message == null ? '' : redact(action.message)
      const status = await requestJson('https://glados.one/api/user/status', {
        method: 'GET',
        headers: browserHeaders(cookie, 'GET'),
      }, 'status')
      const rawDays = status?.data?.leftDays
      leftDays = rawDays == null || rawDays === '' || !Number.isFinite(Number(rawDays))
        ? 'unknown'
        : Number(rawDays)
      console.log(`Account ${index}: ${already ? 'already checked in' : 'success'}`)
      console.log(`Message: ${message}`)
      console.log(`Left days: ${leftDays}`)
      notice.push(already ? 'Already checked in' : 'Checkin OK', message, `Left Days ${leftDays}`)
    } catch (error) {
      failed = true
      const reason = redact(error instanceof Error ? error.message : error)
      const shown = message && message !== reason ? `${message} (${reason})` : (message || reason)
      console.log(`Account ${index}: failed`)
      console.log(`Message: ${shown}`)
      console.log(`Left days: ${leftDays}`)
      notice.push(
        'Checkin Error',
        redact(error),
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
    }
  }

  if (index === 0) {
    console.log('GLADOS is empty')
    return { notice: null, failed: true }
  }

  return { notice, failed }
}

const notify = async (notice) => {
  if (!process.env.NOTIFY || !notice) return
  for (const option of String(process.env.NOTIFY).split('\n')) {
    if (!option) continue
    try {
      if (option.startsWith('console:')) {
        for (const line of notice) {
          console.log(line)
        }
      } else if (option.startsWith('wxpusher:')) {
        await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: option.split(':')[1],
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: option.split(':').slice(2),
          }),
        })
      } else if (option.startsWith('pushplus:')) {
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option.split(':')[1],
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      } else if (option.startsWith('qyweixin:')) {
        const qyweixinToken = option.split(':')[1]
        const qyweixinNotifyRebotUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyweixinToken;
        await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
                content: notice.join('<br>')
            }
          }),
        })
      } else {
        // fallback
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      }
    } catch (error) {
      throw error
    }
  }
}

const main = async () => {
  const { notice, failed } = await glados()
  await notify(notice)
  if (failed) process.exitCode = 1
}

const redactSecrets = (text) => {
  const secrets = [
    process.env.GLADOS || '',
    ...String(process.env.GLADOS || '').split('\n'),
  ]
  for (const option of String(process.env.NOTIFY || '').split('\n')) {
    if (!option) continue
    secrets.push(option)
    for (const part of option.split(':').slice(1)) {
      if (part) secrets.push(part)
    }
  }
  let value = String(text)
  for (const secret of secrets) {
    if (secret && secret.length >= 8) value = value.split(secret).join('[redacted]')
  }
  return value
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error)
  console.log(redactSecrets(reason))
  process.exitCode = 1
})
