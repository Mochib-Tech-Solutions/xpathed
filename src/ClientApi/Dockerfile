# check=error=true
FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 AS dependencies
WORKDIR /source
ENV NUGET_PACKAGES=/opt/nuget
COPY global.json Directory.Build.props .editorconfig ./
COPY src/Common/Common.csproj src/Common/packages.lock.json src/Common/
COPY src/ClientApi/ClientApi.csproj src/ClientApi/packages.lock.json src/ClientApi/
RUN dotnet restore src/ClientApi/ClientApi.csproj --locked-mode

FROM dependencies AS development
COPY --chown=app:app src/Common/ src/Common/
COPY --chown=app:app src/ClientApi/ src/ClientApi/
RUN chown -R app:app /source /opt/nuget
ENV DOTNET_CLI_HOME=/tmp/dotnet
USER app
CMD ["dotnet", "watch", "--non-interactive", "--project", "src/ClientApi", "run", "--no-restore", "--no-launch-profile"]

FROM dependencies AS build
COPY src/Common/ src/Common/
COPY src/ClientApi/ src/ClientApi/
RUN dotnet publish src/ClientApi/ClientApi.csproj -c Release --no-restore -o /out && chmod -R a+rX /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f AS runtime
WORKDIR /app
COPY --from=build /out .
USER app
ENTRYPOINT ["dotnet", "ClientApi.dll"]
