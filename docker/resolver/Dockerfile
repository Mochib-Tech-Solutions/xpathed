# check=error=true
FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 AS dependencies
WORKDIR /source
ENV NUGET_PACKAGES=/opt/nuget
COPY global.json Directory.Build.props .editorconfig ./
COPY src/Common/Common.csproj src/Common/packages.lock.json src/Common/
COPY src/Resolver/Resolver.csproj src/Resolver/packages.lock.json src/Resolver/
RUN dotnet restore src/Resolver/Resolver.csproj --locked-mode

FROM dependencies AS build
COPY src/Common/ src/Common/
COPY src/Resolver/ src/Resolver/
RUN dotnet publish src/Resolver/Resolver.csproj -c Release --no-restore -o /out && chmod -R a+rX /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble-chiseled-extra@sha256:00e0ad6a7ef8c0c1391b87f05c7ac757a15740455688f2bfcd146a3f4b987efd AS runtime
WORKDIR /app
COPY --from=build /out .
USER app
ENTRYPOINT ["dotnet", "Resolver.dll"]
