import { ApiInfo, ApiStream, ApiAggregate, ApiStats, CustomerStatus, Customer } from "./types";

export async function fetchFromRtpulse<T>(
  apiUrl: string,
  path: string,
  timeout = 5000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCustomerStatus(customer: Customer): Promise<CustomerStatus> {
  try {
    const [info, aggregate, stats] = await Promise.all([
      fetchFromRtpulse<ApiInfo>(customer.apiUrl, "/api/info"),
      fetchFromRtpulse<ApiAggregate>(customer.apiUrl, "/api/aggregate"),
      fetchFromRtpulse<ApiStats>(customer.apiUrl, "/api/stats"),
    ]);
    return { customer, info, aggregate, stats, reachable: true };
  } catch (e: unknown) {
    return {
      customer,
      reachable: false,
      error: e instanceof Error ? e.message : "Connection failed",
    };
  }
}
