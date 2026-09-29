FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 AS build
WORKDIR /source
COPY global.json Directory.Build.props Xpathed.slnx .editorconfig ./
COPY src/Contracts/ src/Contracts/
COPY src/ClientApi/ src/ClientApi/
COPY src/Resolver/ src/Resolver/
COPY src/Browser/ src/Browser/
RUN --mount=type=cache,target=/root/.nuget/packages dotnet restore Xpathed.slnx --locked-mode
RUN --mount=type=cache,target=/root/.nuget/packages dotnet publish src/ClientApi -c Release --no-restore -o /out/client-api && \
    dotnet publish src/Resolver -c Release --no-restore -o /out/resolver && \
    dotnet publish src/Browser -c Release --no-restore -o /out/browser && \
    chmod -R a+rX /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f AS client-api
WORKDIR /app
COPY --from=build /out/client-api .
USER app
ENTRYPOINT ["dotnet", "ClientApi.dll"]

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f AS resolver
WORKDIR /app
COPY --from=build /out/resolver .
USER app
ENTRYPOINT ["dotnet", "Resolver.dll"]

FROM mcr.microsoft.com/playwright/dotnet:v1.63.0-noble@sha256:aa3eaf29a65df8c93fc32ab20cf9359f4d8ecc53e6e89f79378647ace87b46b3 AS browser
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc && rm -rf /var/lib/apt/lists/*
ENV ASPNETCORE_HTTP_PORTS=8080 DOTNET_EnableDiagnostics=0
WORKDIR /app
USER pwuser

COPY --from=build /out/browser .
ENTRYPOINT ["dotnet", "Browser.dll"]
