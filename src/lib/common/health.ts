import {
  Controller,
  type DynamicModule,
  Get,
  Inject,
  Module,
  type ModuleMetadata,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Public } from "./request-context.js";

export type HealthChecks = Record<string, () => Promise<unknown>>;

const HEALTH_CHECKS = Symbol("HEALTH_CHECKS");

const withTimeout = (p: Promise<unknown>, ms: number) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

// /health/live: the process is up. /health/ready: every dependency answers,
// so an orchestrator only sends traffic to instances that can serve it.
@Public()
@Controller("health")
class HealthController {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthChecks) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const results = await Promise.all(
      Object.entries(this.checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), 2000);
          return [name, "ok"] as const;
        } catch {
          return [name, "down"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    if (results.some(([, s]) => s !== "ok")) {
      throw new ServiceUnavailableException({ error: "Not ready.", code: "UNAVAILABLE", checks });
    }
    return { status: "ok", checks };
  }
}

@Module({})
export class HealthModule {
  static register(options: {
    imports?: ModuleMetadata["imports"];
    inject?: unknown[];
    useFactory: (...deps: never[]) => HealthChecks;
  }): DynamicModule {
    return {
      module: HealthModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_CHECKS,
          inject: (options.inject ?? []) as never[],
          useFactory: options.useFactory as (...args: unknown[]) => HealthChecks,
        },
      ],
    };
  }
}
