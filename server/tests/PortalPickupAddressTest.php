<?php

namespace Fleetbase\CustomerPortal\Tests;

use Fleetbase\CustomerPortal\Services\PortalOrderService;
use Fleetbase\CustomerPortal\Services\PortalPickupAddressService;
use Illuminate\Container\Container;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Facade;
use Illuminate\Translation\ArrayLoader;
use Illuminate\Translation\Translator;
use Illuminate\Validation\Factory;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\TestCase;
use PDO;
use ReflectionClass;

class PickupTestAccount extends \Illuminate\Database\Eloquent\Model
{
    protected $table = 'pickup_test_accounts';
    protected $primaryKey = 'uuid';
    protected $keyType = 'string';
    public $incrementing = false;
    public $timestamps = false;
    protected $guarded = [];
    protected $casts = ['meta' => 'array'];
}

class PortalPickupAddressTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $container = new Container();
        Container::setInstance($container);
        $container->instance(\Fleetbase\FleetOps\Models\Place::class, (new ReflectionClass(\Fleetbase\FleetOps\Models\Place::class))->newInstanceWithoutConstructor());
        $container->instance('config', new \Illuminate\Config\Repository([
            'api' => ['cache' => ['enabled' => false]], 'fleetbase' => ['connection' => ['db' => 'mysql']],
        ]));
        $store = new \Illuminate\Session\Store('test', new \Illuminate\Session\ArraySessionHandler(120));
        $store->put('company', 'company-1');
        $container->instance('session', $store);
        $container->instance(\Illuminate\Contracts\Routing\ResponseFactory::class, new class {
            public function json($data) { return new \Illuminate\Http\JsonResponse($data); }
        });
        $container->instance('validator', new Factory(new Translator(new ArrayLoader(), 'en'), $container));
        Facade::setFacadeApplication($container);
        Facade::clearResolvedInstances();
    }

    protected function accountFixtures(): array
    {
        $connection = new \Illuminate\Database\SQLiteConnection(new PDO('sqlite::memory:'));
        $resolver = new \Illuminate\Database\ConnectionResolver(['mysql' => $connection]);
        $resolver->setDefaultConnection('mysql');
        \Illuminate\Database\Eloquent\Model::setConnectionResolver($resolver);
        Container::getInstance()->instance('db', new class($connection) {
            public function __construct(public \Illuminate\Database\SQLiteConnection $connection) {}
            public function connection($name = null) { return $this->connection; }
        });
        \Illuminate\Database\Eloquent\Model::unsetEventDispatcher();
        $connection->getSchemaBuilder()->create('pickup_test_accounts', function ($table) {
            $table->string('uuid')->primary();
            $table->text('meta');
        });
        $connection->getSchemaBuilder()->create('places', function ($table) {
            $table->string('uuid')->primary();
            $table->string('public_id')->nullable();
            $table->string('company_uuid');
            $table->string('owner_uuid');
            $table->string('owner_type');
            $table->string('name')->nullable();
            $table->string('street1')->nullable();
            $table->string('phone')->nullable();
            $table->string('city')->nullable();
            $table->string('country')->nullable();
            $table->binary('location')->nullable();
            $table->softDeletes();
            $table->timestamps();
        });
        $account = PickupTestAccount::create(['uuid' => 'account-1', 'meta' => ['customer_portal' => ['pickup_address_uuid' => 'pickup-1']]]);
        $connection->table('places')->insert([
            'uuid' => 'pickup-1', 'company_uuid' => 'company-1',
            'owner_uuid' => 'account-1', 'owner_type' => PickupTestAccount::class,
        ]);
        return [$connection, $account];
    }

    protected function spatialWrites($connection): void
    {
        $connection->getPdo()->sqliteCreateFunction('ST_GeomFromText', function ($wkt) {
            preg_match('/POINT\(([-0-9.]+) ([-0-9.]+)\)/i', $wkt, $matches);
            return pack('VCVdd', 4326, 1, 1, (float) $matches[1], (float) $matches[2]);
        }, -1);
        $connection->getPdo()->sqliteCreateFunction('ST_AsText', fn ($value) => $value, 1);
        \Fleetbase\FleetOps\Models\Place::query();
        $dispatcher = new \Illuminate\Events\Dispatcher(Container::getInstance());
        $dispatcher->listen('eloquent.creating: ' . \Fleetbase\FleetOps\Models\Place::class, function ($place) {
            $place->uuid = (string) \Illuminate\Support\Str::uuid();
        });
        \Illuminate\Database\Eloquent\Model::setEventDispatcher($dispatcher);
    }

    public function testProfileChangesReplaceAssociationWithoutChangingHistoricalAddressAndReuseExactMatch(): void
    {
        [$connection, $account] = $this->accountFixtures();
        $this->spatialWrites($connection);
        $service = new PortalPickupAddressService();
        $first = $service->put(['street1' => 'Original', 'phone' => '123', 'latitude' => 36, 'longitude' => 10], ['account' => $account]);
        $second = $service->put(['street1' => 'Changed', 'phone' => '456', 'latitude' => 37, 'longitude' => 11], ['account' => $account]);
        self::assertNotSame($first->uuid, $second->uuid);
        self::assertSame('Original', $connection->table('places')->where('uuid', $first->uuid)->value('street1'));
        self::assertSame('123', $connection->table('places')->where('uuid', $first->uuid)->value('phone'));
        self::assertSame($second->uuid, data_get($account->fresh()->meta, 'customer_portal.pickup_address_uuid'));
        self::assertSame(37.0, $service->get(['account' => $account])->location->getLat());
        self::assertSame(11.0, $service->get(['account' => $account])->location->getLng());
        $again = $service->put(['street1' => 'Changed', 'phone' => '456', 'latitude' => 37, 'longitude' => 11], ['account' => $account]);
        self::assertSame($second->uuid, $again->uuid);
    }

    public function testNewOrderValidatesCurrentPickupAndDropoffPhone(): void
    {
        [$connection, $account] = $this->accountFixtures();
        $this->spatialWrites($connection);
        $context = ['account' => $account];
        $pickup = (new PortalPickupAddressService())->put([
            'street1' => 'Warehouse', 'phone' => '123', 'latitude' => 36, 'longitude' => 10,
        ], $context);
        $service = new PortalOrderService();
        $input = ['pickup' => $pickup->uuid, 'dropoff' => ['street1' => 'Recipient', 'phone' => '456']];
        $service->validateNewOrder(new Request($input), $context);
        self::assertTrue(true);
        foreach ([
            ['pickup' => ['uuid' => $pickup->uuid, 'latitude' => 35, 'longitude' => 10]],
            ['pickup' => ['uuid' => $pickup->uuid, 'phone' => 'changed']],
            ['dropoff' => ['street1' => 'Recipient']],
        ] as $changes) {
            try {
                $service->validateNewOrder(new Request(array_merge($input, $changes)), $context);
                self::fail('Invalid new order accepted.');
            } catch (ValidationException $exception) {
                self::assertNotEmpty($exception->errors());
            }
        }
    }

    public function testCustomerCatalogueOffersExpressWithoutChangingSharedAdminCatalogue(): void
    {
        $response = (new \Fleetbase\CustomerPortal\Http\Controllers\Internal\v1\DeliveryOptionsController())->index()->getData(true);
        self::assertSame(['transportation'], array_column($response['purposes'], 'value'));
        self::assertSame(['standard', 'express'], array_column($response['service_levels'], 'value'));
        self::assertTrue($response['service_levels'][1]['available']);
        self::assertFalse(\Fleetbase\FleetOps\Support\DeliveryOptions::catalogue()['service_levels'][1]['available']);
    }

    public function testPickupGetIsScopedByAccountCompanyAndOwnerType(): void
    {
        [$connection, $account] = $this->accountFixtures();
        $service = new PortalPickupAddressService();
        self::assertSame('pickup-1', $service->get(['account' => $account])->uuid);
        foreach ([
            ['owner_uuid' => 'other-account'],
            ['owner_uuid' => 'account-1', 'company_uuid' => 'other-company'],
            ['company_uuid' => 'company-1', 'owner_type' => 'different-account-type'],
        ] as $values) {
            $connection->table('places')->where('uuid', 'pickup-1')->update($values);
            self::assertNull($service->get(['account' => $account]));
        }
    }

    public function testDeletedOrMissingPickupReturnsNull(): void
    {
        [$connection, $account] = $this->accountFixtures();
        $service = new PortalPickupAddressService();
        $connection->table('places')->where('uuid', 'pickup-1')->update(['deleted_at' => '2026-01-01 00:00:00']);
        self::assertNull($service->get(['account' => $account]));
        $connection->table('places')->delete();
        self::assertNull($service->get(['account' => $account]));
    }

    public function testAddressBookDeleteClearsOnlyCurrentAccountDefaultAndCannotDeleteAnotherAccountPlace(): void
    {
        [$connection, $account] = $this->accountFixtures();
        $resolver = $this->createMock(\Fleetbase\CustomerPortal\Services\PortalAccountResolver::class);
        $resolver->method('resolve')->willReturn(['account' => $account]);
        Container::getInstance()->instance(\Illuminate\Contracts\Routing\ResponseFactory::class, new class {
            public function json($data) { return new \Illuminate\Http\JsonResponse($data); }
        });
        $controller = new \Fleetbase\CustomerPortal\Http\Controllers\Internal\v1\PlaceController($resolver);
        $connection->table('places')->insert([
            'uuid' => 'other-pickup', 'company_uuid' => 'company-1',
            'owner_uuid' => 'other-account', 'owner_type' => PickupTestAccount::class,
        ]);
        try {
            $controller->delete('other-pickup');
            self::fail('Cross-account deletion accepted.');
        } catch (\Illuminate\Database\Eloquent\ModelNotFoundException $exception) {
            self::assertSame('pickup-1', data_get($account->fresh()->meta, 'customer_portal.pickup_address_uuid'));
        }
        $controller->delete('pickup-1');
        self::assertNull(data_get($account->fresh()->meta, 'customer_portal.pickup_address_uuid'));
        self::assertNotNull($connection->table('places')->where('uuid', 'pickup-1')->value('deleted_at'));
        self::assertNull($connection->table('places')->where('uuid', 'other-pickup')->value('deleted_at'));
    }

    public function testPickupAcceptsGeoJsonAndNormalizesAddressAndPhone(): void
    {
        $input = PortalPickupAddressService::validatedInput([
            'address' => ' Warehouse ', 'phone' => ' +21612345678 ',
            'location' => ['type' => 'Point', 'coordinates' => [10.1, 36.2]],
        ]);
        self::assertSame('Warehouse', $input['street1']);
        self::assertSame('+21612345678', $input['phone']);
        self::assertSame(36.2, $input['latitude']);
        self::assertSame(10.1, $input['longitude']);
    }

    public function testPickupAllowsZeroCoordinates(): void
    {
        $input = PortalPickupAddressService::validatedInput([
            'street1' => 'Warehouse', 'phone' => '123', 'latitude' => 0, 'longitude' => 0,
        ]);
        self::assertSame(0, $input['latitude']);
    }

    public function testPickupRejectsMissingStreetPhoneAndCoordinates(): void
    {
        foreach ([
            ['street1' => ' ', 'phone' => '123', 'latitude' => 36, 'longitude' => 10],
            ['street1' => 'Warehouse', 'phone' => ' ', 'latitude' => 36, 'longitude' => 10],
            ['street1' => 'Warehouse', 'phone' => '123'],
            ['street1' => 'Warehouse', 'phone' => '123', 'latitude' => 91, 'longitude' => 10],
            ['street1' => 'Warehouse', 'phone' => ['invalid'], 'latitude' => 36, 'longitude' => 10],
        ] as $input) {
            try {
                PortalPickupAddressService::validatedInput($input);
                self::fail('Invalid pickup accepted.');
            } catch (ValidationException $exception) {
                self::assertNotEmpty($exception->errors());
            }
        }
    }

    public function testNewOrderRejectsHiddenUnsupportedRoutesBeforeResolvingPlaces(): void
    {
        foreach ([
            ['return' => ['street1' => 'Return']],
            ['payload' => ['waypoints' => [['street1' => 'Intermediate']]]],
            ['meta' => ['delivery' => ['purpose' => 'return']]],
            ['meta' => ['delivery' => ['service_level' => 'overnight']]],
            ['meta' => ['delivery' => ['original_order_uuid' => 'historical-order']]],
        ] as $input) {
            try {
                (new PortalOrderService())->validateNewOrder(new Request($input), []);
                self::fail('Unsupported new order accepted.');
            } catch (ValidationException $exception) {
                self::assertNotEmpty($exception->errors());
            }
        }
    }

    public function testNewOrderRejectsPastAndInvalidScheduleBeforeResolvingPlaces(): void
    {
        foreach (['2001-01-01T10:00:00Z', 'not-a-date'] as $date) {
            try {
                (new PortalOrderService())->validateNewOrder(new Request(['scheduled_at' => $date]), []);
                self::fail('Invalid schedule accepted.');
            } catch (ValidationException $exception) {
                self::assertArrayHasKey('scheduled_at', $exception->errors());
            }
        }
    }
}
