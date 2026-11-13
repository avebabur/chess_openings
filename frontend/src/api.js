import axios from 'axios'

/** Dev: Vite on :5174, Openings API on :8001. Production: same origin /api */
export const API = import.meta.env.DEV
  ? 'http://127.0.0.1:8001/api'
  : '/api'

const RETRY_STATUS = new Set([502, 503, 504])
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 400
const IDEMPOTENT_POST_PATHS = [
  /^\/repertoire\/tree\/branches$/,
]
const IDEMPOTENT_PATCH_PATHS = [
  /^\/repertoire\/tree\/branches\/\d+$/,
]

function canRetry(config) {
  const method = (config.method || 'get').toLowerCase()
  if (method === 'get' || method === 'head') return true
  if (method === 'post') {
    const path = (config.url || '').replace(API, '')
    return IDEMPOTENT_POST_PATHS.some(re => re.test(path))
  }
  if (method === 'patch') {
    const path = (config.url || '').replace(API, '')
    return IDEMPOTENT_PATCH_PATHS.some(re => re.test(path))
  }
  return false
}

export const api = axios.create({ baseURL: API })

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config
    if (!config) return Promise.reject(error)

    const retryCount = config.__retryCount ?? 0
    if (retryCount >= MAX_RETRIES) return Promise.reject(error)

    const status = error.response?.status
    const networkError = !error.response
      && (error.code === 'ERR_NETWORK' || error.code === 'ECONNABORTED')

    if ((!networkError && !RETRY_STATUS.has(status)) || !canRetry(config)) {
      return Promise.reject(error)
    }

    config.__retryCount = retryCount + 1
    await new Promise((resolve) => {
      setTimeout(resolve, RETRY_DELAY_MS * config.__retryCount)
    })
    return api(config)
  },
)

/** The backend's own message for a failed request, or `fallback`. */
export function errorText(err, fallback) {
  const detail = err?.response?.data?.detail
  return typeof detail === 'string' ? detail : (err?.message || fallback)
}
