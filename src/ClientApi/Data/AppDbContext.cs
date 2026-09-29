using Microsoft.EntityFrameworkCore;

namespace Xpathed.ClientApi.Data;

internal sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options);
