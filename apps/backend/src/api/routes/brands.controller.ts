// Brand profile: the user's brands, creating one, and reading and changing the current one.
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import {
  AdminRequiredException,
  BrandsService,
  BrandSummary,
  BrandView,
} from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import {
  CreateBrand,
  UpdateBrand,
} from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

// The `/brands` endpoints: create a brand, list the user's brands, read and change the current one.
@ApiTags('Brands')
@Controller('/brands')
export class BrandsController {
  // Receives the service that owns the brands.
  constructor(private _brandsService: BrandsService) {}

  // Creates a brand for the calling user; the body is validated by the service, not by the pipe.
  @Post('/')
  create(
    @GetUserFromRequest() user: User,
    @Body() body: unknown
  ): Promise<BrandView> {
    return this._brandsService.create(user.id, body as CreateBrand);
  }

  // Lists the calling user's brands.
  @Get('/')
  list(@GetUserFromRequest() user: User): Promise<BrandSummary[]> {
    return this._brandsService.listForUser(user.id);
  }

  // The brand of the calling workspace.
  @Get('/current')
  current(@GetOrgFromRequest() org: Organization): Promise<BrandView> {
    return this._brandsService.get(org.id);
  }

  // Changes the brand of the calling workspace; admins only.
  @Put('/current')
  update(
    @GetOrgFromRequest() org: Organization,
    @Body() body: unknown
  ): Promise<BrandView> {
    this.assertAdmin(org);
    return this._brandsService.update(org.id, body as UpdateBrand);
  }

  // A brand the calling user is a member of, by workspace id; 404 when they are not.
  @Get('/:id')
  get(
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ): Promise<BrandView> {
    return this._brandsService.getForUser(user.id, id);
  }

  // Changes a brand by workspace id for its admins, wherever the calling tab is; 403 for a USER member.
  @Put('/:id')
  updateById(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<BrandView> {
    return this._brandsService.updateForUser(user.id, id, body as UpdateBrand);
  }

  // Refuses a member who is not an admin of the workspace; the policy guard no longer tells roles apart.
  private assertAdmin(org: Organization) {
    const role = (org as Organization & { users?: { role: string }[] })
      .users?.[0]?.role;
    if (role !== 'ADMIN' && role !== 'SUPERADMIN') {
      throw new AdminRequiredException();
    }
  }
}
