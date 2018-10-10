# worlda11y
A comprehensive travel time dataset for the entire landmass of the world to the nearest town.

This project aims to create a dataset of actual traveltime from any area of the world to its nearest town. It uses
[OpenStreetMap](https://osm.org) and [OSRM](http://project-osrm.org/) to calculate the traveltime by car from
6 million randomly distributed points on the globe's landmass and islands to their nearest town.

It is based on my work for the [Rural Accessibility Map](https://github.com/WorldBank-Transport/ram) at the World Bank.
It uses the same algorithm to calculate the travel time to the nearest POI (town in our case). But due to the sheer amount
of data required and the limitations of Node and javascript it is as bare bones as possible to allow for as much memory
and processing power as possible.

The towns are sourced from ... (TODO)

The 6 million points are randomly created by PostGIS's
[ST_GeneratePoints](https://postgis.net/docs/ST_GeneratePoints.html) within the landmasses and islands from
[Natural Earth](https://www.naturalearthdata.com/) data. Due to the filesize limitations of Node these points have been
divided into various continents.

Each continent has to be run separately and the resulting CSV files should be joined with `sed MAGIC` (TODO)

# preparation

1. Download the OpenStreetMap data extract of the area you are interested in from [geofabrik](http://download.geofabrik.de/) and put it in `osrm`. The default settings expect the [central-america-latest](http://download.geofabrik.de/central-america-latest.osm.pbf) extract.
2. Prepare the [OSRM](https://github.com/Project-OSRM/osrm-backend) routing graph. Note that preparing the entire world at once requires a lot of memory on your machine! Also the new OSRM seems to take a lot longer to generate the graphs :(.
**Beware**: OSRM is really sensitive in its versions. Routing graphs created with one version of OSRM cannot be used by the node-binding with a different version. At the time of writing the working combination is v5.18.0:
```
 cd osrm
 docker run --rm -t -v $(pwd):/data osrm/osrm-backend:v5.18.0 osrm-extract -p /opt/car.lua /data/<osm data extract>.osm.pbf
 docker run --rm -t -v $(pwd):/data osrm/osrm-backend:v5.18.0 osrm-contract /data/<osm data extract>.osrm
```

# running

Running is fairly easy - once you have the OSRM files setup. Currently only the data for Central America is in the repo. The other regions will follow soon.
1. `nvm install 8`
2. `npm install`
3. `node index.js <parameters>`

# parameters
The application takes up to three parameters. The region you are interested in (the name of the .osrm file), the name of the source file (the random points), the name of the destination file (the towns).
0. `node index.js` will run with the default settings which means: it will look for the osrm file `central-america-latest.osrm`, the source file `central-america-latest.json`, the boundary file `central-america-latest-boundary.geojson` and the default source file `towns.geojson`
1. `node index.js europe-latest` It will use the *region* parameter to set the names for all the necessary files as such this will look for the osrm file `europe-latest.osrm`, the source file `europe-latest.json`, the boundary file `europe-latest-boundary.geojson` and the default source file `towns.geojson`
2. `node index.js asia-latest randompoints` this will look for the osrm file `asia-latest.osrm`, the source file `randompoints.json`, the boundary file `randompoints-boundary.geojson` and the default source file `towns.geojson`
3. `node index.js africa-latest regularpoints mytowns.geojson` this will look for the osrm file `afirca-latest.osrm`, the source file `regularpoints.json`, the boundary file `regularpoints-boundary.geojson` and the source file `mytowns.geojson`

# acknowledgments
The whole world-run was inspired by [Bruno ](https://github.com/brunosan)'s [question](https://github.com/WorldBank-Transport/ram-backend/issues/31) on the original Rural Roads Accessibility (RRA) application I wrote for the Worldbank. It turned out that, apart from the difficulty of finding world wide data, the sheer size of the data was an issue for Node. In the end I created a stripped down version the would run one region of the world at a time. In the mean time I left DC and [Developmentseed](https://developmentseed.org/) took over the development of RRA (rebranded Rural Accessibility Mapping - RAM) and created a solid database backed application out of it with a nice interface. They also cleaned up my code and brought it to modern day standards. I've taken [their implementation](https://github.com/WorldBank-Transport/ram-datapipeline) of calculateETA and adapted for this usecase.