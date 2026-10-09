# check=error=true
FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 AS dependencies
WORKDIR /source
ENV NUGET_PACKAGES=/opt/nuget
COPY global.json Directory.Build.props .editorconfig ./
COPY src/Common/Common.csproj src/Common/packages.lock.json src/Common/
COPY src/Browser/Browser.csproj src/Browser/packages.lock.json src/Browser/
RUN dotnet restore src/Browser/Browser.csproj --locked-mode

FROM dependencies AS build
COPY src/Common/ src/Common/
COPY src/Browser/ src/Browser/
RUN dotnet publish src/Browser/Browser.csproj -c Release --no-restore -o /out && chmod -R a+rX /out

FROM mcr.microsoft.com/playwright/dotnet:v1.63.0-noble@sha256:aa3eaf29a65df8c93fc32ab20cf9359f4d8ecc53e6e89f79378647ace87b46b3 AS browser-base
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc && rm -rf /var/lib/apt/lists/*

FROM browser-base AS development
WORKDIR /source
ENV NUGET_PACKAGES=/opt/nuget DOTNET_CLI_HOME=/tmp/dotnet ASPNETCORE_HTTP_PORTS=8080
COPY --from=dependencies --chown=pwuser:pwuser /opt/nuget /opt/nuget
COPY --from=dependencies --chown=pwuser:pwuser /source /source
COPY --chown=pwuser:pwuser src/Common/ src/Common/
COPY --chown=pwuser:pwuser src/Browser/ src/Browser/
RUN chown pwuser:pwuser /source
USER pwuser
CMD ["dotnet", "watch", "--non-interactive", "--project", "src/Browser", "run", "--no-restore", "--no-launch-profile"]

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f AS runtime
ENV ASPNETCORE_HTTP_PORTS=8080 DOTNET_EnableDiagnostics=0 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /out .
RUN dotnet exec --runtimeconfig Browser.runtimeconfig.json --depsfile Browser.deps.json Microsoft.Playwright.dll install --with-deps --no-shell chromium \
    && apt-get install -y --no-install-recommends x11vnc \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home pwuser \
    && chmod -R a+rX /ms-playwright
USER pwuser
ENTRYPOINT ["dotnet", "Browser.dll"]
