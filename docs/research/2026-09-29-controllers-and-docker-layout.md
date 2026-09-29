# Controllers and Docker layout

Reviewed 2026-09-29 against current Microsoft, Docker and Playwright documentation. Folder choices below are project conventions; framework behavior is linked separately.

## API controllers

Each .NET API uses `Controllers/` with public classes deriving from `ControllerBase`, `[ApiController]` and explicit attribute routes. `Program.cs` registers services with `AddControllers()` and exposes actions through `MapControllers()`. Request existing services through constructor injection; controllers handle HTTP concerns while service classes own browser operations and forwarding. [Web API controllers](https://learn.microsoft.com/en-us/aspnet/core/web-api/?view=aspnetcore-10.0), [controller responsibilities](https://learn.microsoft.com/en-us/aspnet/core/mvc/controllers/actions?view=aspnetcore-10.0), [controller dependency injection](https://learn.microsoft.com/en-us/aspnet/core/mvc/controllers/dependency-injection?view=aspnetcore-10.0)

`[ApiController]` automatically rejects invalid model state with HTTP 400 and normally returns `ValidationProblemDetails`. Preserve the existing `{code, message, traceId}` error contract through `InvalidModelStateResponseFactory`. Leave automatic validation enabled and retain domain validation, such as permitted navigation URL schemes, in the owning service. [Automatic 400 responses and customization](https://learn.microsoft.com/en-us/aspnet/core/web-api/?view=aspnetcore-10.0#automatic-http-400-responses)

The viewer controller must keep its action active until the WebSocket relay finishes. Use a route attribute that permits HTTP/2 `CONNECT` as well as HTTP/1.1 upgrades; Microsoft recommends `[Route]` instead of `[HttpGet]` for WebSocket actions. Keep the current origin checks and cancellation lifetime. [ASP.NET Core WebSockets](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/websockets?view=aspnetcore-10.0)

## Files and shared code

Use one explicitly declared class or record per matching `.cs` file, as requested for this repository. Microsoft documents PascalCase type names and namespaces that typically mirror folders; C# itself permits multiple types in a file. Use file-scoped namespaces such as `Xpathed.Browser.Controllers`. [Identifier conventions](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/identifier-names), [namespaces](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/program-structure/namespaces)

`Common` contains contracts and HTTP behavior used by multiple services. Browser lifecycle, resolver behavior and client persistence remain with their owning projects. Keep the existing service boundaries and use folders to separate responsibilities within them. Additional application/domain/infrastructure projects need a concrete dependency or ownership reason; the Microsoft architecture guide describes trade-offs rather than one mandatory project template. [Application structure](https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures)

## Docker files

Compose definitions and its command wrapper live in `docker/`. Each service has a `docker/<service>/Dockerfile` with separate development and runtime targets; browser security files and nginx configuration sit beside their Dockerfiles. `.dockerignore` stays at the repository root, which remains the build context for shared source. `COPY` paths resolve from that context. [Docker build context](https://docs.docker.com/build/concepts/context/)

`docker/compose.sh` passes the canonical repository root as `--project-directory`, so build context, source synchronization paths and the root `.env` retain their existing base after moving the Compose files. Validate the combined configuration after path changes. [Compose CLI project directory](https://docs.docker.com/reference/cli/docker/compose/), [Compose file merging](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/)

Application quality checks remain independent of Docker. CI validates Compose plus both Dockerfile targets with `--check`; image builds and container startup remain explicit commands. [Docker build checks](https://docs.docker.com/build/checks/)
