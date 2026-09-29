using Microsoft.EntityFrameworkCore;

namespace Xpathed.ClientApi.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options);
