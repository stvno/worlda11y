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
