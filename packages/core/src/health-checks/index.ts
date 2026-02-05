/**
 * Health Checks & Monitoring - Endpoint monitoring, synthetic monitoring, uptime tracking
 */

export interface HealthCheck { id: string; url: string; interval: number; timeout: number; status: 'healthy' | 'unhealthy' }
export interface SyntheticMonitor { id: string; name: string; script: string; frequency: number; locations: string[] }
export interface UptimeTracker { id: string; resource: string; uptime: number; downtime: number; availability: number }

export class HealthCheckManager {
  private checks = new Map<string, HealthCheck>()
  private synthetics = new Map<string, SyntheticMonitor>()
  private uptimeTrackers = new Map<string, UptimeTracker>()
  private counter = 0

  createHealthCheck(url: string, interval = 30, timeout = 10): HealthCheck {
    const id = `health-${Date.now()}-${this.counter++}`
    const check = { id, url, interval, timeout, status: 'healthy' as const }
    this.checks.set(id, check)
    return check
  }

  createSyntheticMonitor(name: string, script: string, frequency: number, locations: string[]): SyntheticMonitor {
    const id = `synthetic-${Date.now()}-${this.counter++}`
    const monitor = { id, name, script, frequency, locations }
    this.synthetics.set(id, monitor)
    return monitor
  }

  trackUptime(resource: string, uptime: number, downtime: number): UptimeTracker {
    const id = `uptime-${Date.now()}-${this.counter++}`
    const availability = (uptime / (uptime + downtime)) * 100
    const tracker = { id, resource, uptime, downtime, availability }
    this.uptimeTrackers.set(id, tracker)
    return tracker
  }

  clear(): void { this.checks.clear(); this.synthetics.clear(); this.uptimeTrackers.clear() }
}

export const healthCheckManager: HealthCheckManager = new HealthCheckManager()
