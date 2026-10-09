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

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble-chiseled-extra@sha256:00e0ad6a7ef8c0c1391b87f05c7ac757a15740455688f2bfcd146a3f4b987efd AS dotnet-runtime

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS browser-base
ARG CHROMIUM_VERSION=154.0.8037.92-1~deb13u1
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium=${CHROMIUM_VERSION} ca-certificates libicu76 libssl3t64 libstdc++6 tzdata fonts-freefont-ttf fonts-ipafont-gothic fonts-liberation fonts-noto-color-emoji fonts-tlwg-loma-otf fonts-unifont fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1654 app \
    && useradd --uid 1654 --gid 1654 --create-home app
COPY --from=dotnet-runtime /usr/share/dotnet /usr/share/dotnet
ENV PATH="/usr/share/dotnet:${PATH}" DOTNET_RUNNING_IN_CONTAINER=true ASPNETCORE_HTTP_PORTS=8080 DOTNET_EnableDiagnostics=0 BrowserExecutablePath=/usr/lib/chromium/chromium
USER app

FROM browser-base AS runtime
WORKDIR /app
COPY --from=build /out .
ENTRYPOINT ["dotnet", "Browser.dll"]
