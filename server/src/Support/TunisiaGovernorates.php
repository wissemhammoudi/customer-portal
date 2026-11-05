<?php

namespace Fleetbase\CustomerPortal\Support;

/**
 * Resolves the Tunisian governorate of an address and the delivery region it belongs to.
 * Boundaries: tunisia-governorates.json (geoBoundaries, ODbL 1.0 - (c) OpenStreetMap contributors).
 */
class TunisiaGovernorates
{
    public const GRAND_TUNIS = ['tunis', 'ariana', 'ben_arous', 'manouba'];

    public const REGIONS = [
        'north_east'  => ['tunis', 'ariana', 'ben_arous', 'manouba', 'nabeul', 'bizerte', 'zaghouan'],
        'north_west'  => ['beja', 'jendouba', 'kef', 'siliana'],
        'centre_east' => ['sousse', 'monastir', 'mahdia', 'sfax'],
        'centre_west' => ['kairouan', 'kasserine', 'sidi_bouzid'],
        'south_east'  => ['gabes', 'medenine', 'tataouine'],
        'south_west'  => ['gafsa', 'tozeur', 'kebili'],
    ];

    public const NAMES = [
        'tunis' => ['Tunis', 'تونس'], 'ariana' => ['Ariana', 'أريانة'], 'ben_arous' => ['Ben Arous', 'بن عروس'],
        'manouba' => ['Manouba', 'منوبة'], 'nabeul' => ['Nabeul', 'نابل'], 'bizerte' => ['Bizerte', 'بنزرت'],
        'zaghouan' => ['Zaghouan', 'زغوان'], 'beja' => ['Beja', 'باجة'], 'jendouba' => ['Jendouba', 'جندوبة'],
        'kef' => ['Le Kef', 'الكاف'], 'siliana' => ['Siliana', 'سليانة'], 'sousse' => ['Sousse', 'سوسة'],
        'monastir' => ['Monastir', 'المنستير'], 'mahdia' => ['Mahdia', 'المهدية'], 'sfax' => ['Sfax', 'صفاقس'],
        'kairouan' => ['Kairouan', 'القيروان'], 'kasserine' => ['Kasserine', 'القصرين'],
        'sidi_bouzid' => ['Sidi Bouzid', 'سيدي بوزيد'], 'gabes' => ['Gabes', 'قابس'], 'medenine' => ['Medenine', 'مدنين'],
        'tataouine' => ['Tataouine', 'تطاوين'], 'gafsa' => ['Gafsa', 'قفصة'], 'tozeur' => ['Tozeur', 'توزر'],
        'kebili' => ['Kebili', 'قبلي'],
    ];

    // Points this close (degrees, about 25 km) to a boundary still count, e.g. small islands and the coastline.
    protected const COAST_TOLERANCE = 0.25;

    protected static ?array $boundaries = null;

    /** Coordinates win over the free-text governorate, which customers type themselves. */
    public static function locate(mixed $latitude, mixed $longitude, ?string $province = null): ?string
    {
        $hasPoint = is_numeric($latitude) && is_numeric($longitude);
        if ($hasPoint && ($code = self::containing((float) $longitude, (float) $latitude))) {
            return $code;
        }
        if ($code = self::fromName($province)) {
            return $code;
        }

        return $hasPoint ? self::nearest((float) $longitude, (float) $latitude) : null;
    }

    public static function region(string $code): ?string
    {
        foreach (self::REGIONS as $region => $codes) {
            if (in_array($code, $codes, true)) {
                return $region;
            }
        }

        return null;
    }

    public static function fromName(?string $name): ?string
    {
        $key = self::normalize((string) $name);
        if ($key === '') {
            return null;
        }
        foreach (self::NAMES as $code => $names) {
            $aliases = [$code, str_replace('_', ' ', $code), ...$names];
            foreach ($aliases as $alias) {
                if (self::normalize($alias) === $key) {
                    return $code;
                }
            }
        }

        return null;
    }

    protected static function normalize(string $value): string
    {
        $value = mb_strtolower(trim($value));
        $value = strtr($value, ['é' => 'e', 'è' => 'e', 'ê' => 'e', 'à' => 'a', 'â' => 'a', 'î' => 'i', 'ï' => 'i', 'ô' => 'o', 'û' => 'u', 'ç' => 'c']);
        $value = preg_replace('/^(gouvernorat|governorate|wilaya|ولاية)\s+(de\s+|of\s+|d\')?/u', '', $value);
        $value = preg_replace('/^(le|el|al)\s+/u', '', $value);
        $value = preg_replace('/[\s\-_\'.]+/u', ' ', $value);

        return trim($value);
    }

    protected static function containing(float $x, float $y): ?string
    {
        foreach (self::boundaries() as $code => $rings) {
            foreach ($rings as [$box, $ring]) {
                if ($x < $box[0] || $x > $box[2] || $y < $box[1] || $y > $box[3]) {
                    continue;
                }
                if (self::inRing($x, $y, $ring)) {
                    return $code;
                }
            }
        }

        return null;
    }

    protected static function inRing(float $x, float $y, array $ring): bool
    {
        $inside = false;
        for ($i = 0, $j = count($ring) - 1; $i < count($ring); $j = $i++) {
            [$xi, $yi] = $ring[$i];
            [$xj, $yj] = $ring[$j];
            if (($yi > $y) !== ($yj > $y) && $x < ($xj - $xi) * ($y - $yi) / ($yj - $yi) + $xi) {
                $inside = !$inside;
            }
        }

        return $inside;
    }

    protected static function nearest(float $x, float $y): ?string
    {
        $best = null;
        $bestDistance = self::COAST_TOLERANCE ** 2;
        foreach (self::boundaries() as $code => $rings) {
            foreach ($rings as [$box, $ring]) {
                if ($x < $box[0] - self::COAST_TOLERANCE || $x > $box[2] + self::COAST_TOLERANCE
                    || $y < $box[1] - self::COAST_TOLERANCE || $y > $box[3] + self::COAST_TOLERANCE) {
                    continue;
                }
                foreach ($ring as [$px, $py]) {
                    $distance = ($px - $x) ** 2 + ($py - $y) ** 2;
                    if ($distance < $bestDistance) {
                        $bestDistance = $distance;
                        $best = $code;
                    }
                }
            }
        }

        return $best;
    }

    /** @return array<string, array<int, array{0: array{0: float, 1: float, 2: float, 3: float}, 1: array}>> */
    protected static function boundaries(): array
    {
        if (self::$boundaries === null) {
            $data = json_decode((string) file_get_contents(__DIR__ . '/tunisia-governorates.json'), true, 512, JSON_THROW_ON_ERROR);
            self::$boundaries = [];
            foreach ($data['governorates'] as $code => $rings) {
                foreach ($rings as $ring) {
                    $xs = array_column($ring, 0);
                    $ys = array_column($ring, 1);
                    self::$boundaries[$code][] = [[min($xs), min($ys), max($xs), max($ys)], $ring];
                }
            }
        }

        return self::$boundaries;
    }
}
