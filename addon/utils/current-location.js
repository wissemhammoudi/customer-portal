const HIGH_ACCURACY_OPTIONS = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 10000,
};

const FALLBACK_ACCURACY_OPTIONS = {
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: 30000,
};

function readPosition(geolocation, options) {
    return new Promise((resolve, reject) => {
        geolocation.getCurrentPosition(
            (position) => {
                resolve({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                    accuracy: typeof position.coords.accuracy === 'number' ? position.coords.accuracy : null,
                });
            },
            (error) => reject(error),
            options
        );
    });
}

export function mapBrowserLocationError(error) {
    if (error?.code === 1) {
        return 'Location permission was denied. Enable location access to see your position.';
    }

    if (error?.code === 2) {
        return 'Your current location is unavailable. Turn on GPS or try again.';
    }

    if (error?.code === 3) {
        return 'Finding your location timed out. Please try again.';
    }

    return 'Unable to determine your current location. Please try again.';
}

export async function getBrowserCurrentLocation() {
    const geolocation = globalThis.navigator?.geolocation;

    if (!geolocation) {
        throw new Error('Location services are not supported in this browser.');
    }

    try {
        return await readPosition(geolocation, HIGH_ACCURACY_OPTIONS);
    } catch (error) {
        if (error?.code === 2 || error?.code === 3) {
            try {
                return await readPosition(geolocation, FALLBACK_ACCURACY_OPTIONS);
            } catch (fallbackError) {
                throw new Error(mapBrowserLocationError(fallbackError));
            }
        }

        throw new Error(mapBrowserLocationError(error));
    }
}
