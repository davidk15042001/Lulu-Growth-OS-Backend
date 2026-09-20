import type { NextFunction, Request, Response } from 'express';

const durationBuckets = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const requestCounters = new Map<string, number>();
const durationCounters = new Map<string, number>();
const durationSums = new Map<string, number>();
const durationCounts = new Map<string, number>();
const startedAt = Date.now();

function label(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ');
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const started = performance.now();
  res.once('finish', () => {
    if (req.path === '/metrics') return;
    const seconds = Math.max(0, (performance.now() - started) / 1000);
    const method = label(req.method);
    const status = String(res.statusCode);
    const counterKey = `${method}|${status}`;
    requestCounters.set(counterKey, (requestCounters.get(counterKey) ?? 0) + 1);
    durationSums.set(method, (durationSums.get(method) ?? 0) + seconds);
    durationCounts.set(method, (durationCounts.get(method) ?? 0) + 1);
    for (const bucket of durationBuckets) {
      if (seconds <= bucket) {
        const bucketKey = `${method}|${bucket}`;
        durationCounters.set(bucketKey, (durationCounters.get(bucketKey) ?? 0) + 1);
      }
    }
  });
  next();
}

export function renderPrometheusMetrics() {
  const lines = [
    '# HELP lulu_process_uptime_seconds Process uptime in seconds.',
    '# TYPE lulu_process_uptime_seconds gauge',
    `lulu_process_uptime_seconds ${(Date.now() - startedAt) / 1000}`,
    '# HELP lulu_http_requests_total HTTP responses by method and status.',
    '# TYPE lulu_http_requests_total counter',
  ];
  for (const [key, value] of requestCounters) {
    const [method = 'unknown', status = 'unknown'] = key.split('|');
    lines.push(`lulu_http_requests_total{method="${method}",status="${status}"} ${value}`);
  }
  lines.push('# HELP lulu_http_request_duration_seconds HTTP response duration histogram.', '# TYPE lulu_http_request_duration_seconds histogram');
  const methods = [...new Set([...durationCounters.keys()].map((key) => key.split('|')[0] ?? 'unknown'))];
  for (const method of methods) {
    for (const bucket of durationBuckets) {
      lines.push(`lulu_http_request_duration_seconds_bucket{method="${method}",le="${bucket}"} ${durationCounters.get(`${method}|${bucket}`) ?? 0}`);
    }
    lines.push(`lulu_http_request_duration_seconds_bucket{method="${method}",le="+Inf"} ${durationCounts.get(method) ?? 0}`);
    lines.push(`lulu_http_request_duration_seconds_sum{method="${method}"} ${durationSums.get(method) ?? 0}`);
    lines.push(`lulu_http_request_duration_seconds_count{method="${method}"} ${durationCounts.get(method) ?? 0}`);
  }
  return `${lines.join('\n')}\n`;
}
